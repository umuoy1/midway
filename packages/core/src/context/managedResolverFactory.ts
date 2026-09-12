/**
 * 管理对象解析构建
 */
import {
  CONTAINER_OBJ_SCOPE,
  REQUEST_CTX_KEY,
  REQUEST_OBJ_CTX_KEY,
  SINGLETON_CONTAINER_CTX,
} from '../constants';
import {
  ClassType,
  IMidwayContainer,
  IMidwayGlobalContainer,
  IObjectDefinition,
  ObjectIdentifier,
  ObjectLifeCycleEvent,
  PropertyInjectMetadata,
  ScopeEnum,
} from '../interface';
import * as util from 'util';
import * as EventEmitter from 'events';
import {
  MidwayCommonError,
  MidwayDefinitionNotFoundError,
  MidwaySingletonInjectRequestError,
  MidwayUseWrongMethodError,
} from '../error';
import { FunctionDefinition } from '../definitions/functionDefinition';
import { ObjectCreator } from '../definitions/objectCreator';
import { Types } from '../util/types';

const debug = util.debuglog('midway:debug');

function createProxy<T>(factory: () => T): T {
  let instance: T;
  return new Proxy(
    {},
    {
      get(target, prop) {
        if (!instance) {
          instance = factory();
        }
        return instance[prop];
      },
    }
  ) as T;
}

function formatObjectIdentifier(
  identifier: ObjectIdentifier | (() => ObjectIdentifier | ClassType)
): ObjectIdentifier | ClassType {
  if (typeof identifier === 'function') {
    return identifier();
  }
  return identifier;
}

/** One entry in the existing dependency-first initialization queue. */
interface PendingInitialization {
  instance: any;
  definition: IObjectDefinition;
  context: IMidwayContainer;
  init: () => any;
  replaceCallback?: (value: any) => void;
  creation?: ObjectCreation;
  shared?: boolean;
}

/** Completion shared by queue entries, also reserved globally for singletons. */
interface ObjectCreation {
  definition: IObjectDefinition;
  instance?: any;
  queue?: PendingInitialization[];
  promise: Promise<any>;
  resolve: (value: any) => void;
  reject: (error: any) => void;
  initializing?: boolean;
  result?: { value: any };
  failure?: { error: any };
}

/**
 * 解析工厂
 */
export class ManagedResolverFactory {
  private creating = new Map<string, ObjectCreation>();
  private singletonCacheIds = new Set<string>();
  context: IMidwayGlobalContainer;

  constructor(context: IMidwayGlobalContainer) {
    this.context = context;
  }

  /**
   * 同步创建对象
   * @param identifier
   * @param args
   * @param currentContext
   */
  create<T = any>(
    identifier: ClassType<T> | string,
    args = [],
    currentContext: IMidwayContainer
  ): T {
    const name = typeof identifier === 'string' ? identifier : identifier.name;
    identifier = currentContext.getIdentifier(identifier);
    debug('[core]: create "%s(%s)"', identifier, name);

    if (currentContext.hasObject(identifier)) {
      return currentContext.getObject(identifier);
    }

    const definition = this.getObjectDefinition(identifier);

    if (
      !definition &&
      currentContext !== this.context &&
      this.context.hasObject(identifier)
    ) {
      return this.context.getObject(identifier);
    }

    if (!definition) {
      throw new MidwayDefinitionNotFoundError(identifier, name);
    }

    const pendingInitQueue: PendingInitialization[] = [];
    const pendingObjectCache = new Map<string, any>();
    const ownedCreations = new Set<ObjectCreation>();
    try {
      const instance = this.createInstance(
        identifier,
        name,
        args,
        definition,
        false,
        false,
        currentContext,
        pendingObjectCache,
        pendingInitQueue,
        ownedCreations
      );
      return this.initializeInstance(instance, definition, pendingInitQueue);
    } catch (error) {
      for (const creation of ownedCreations) {
        if (!creation.initializing) this.failCreation(creation, error);
      }
      throw error;
    } finally {
      pendingObjectCache.clear();
    }
  }

  async createAsync<T = any>(
    identifier: ClassType<T> | string,
    args = [],
    currentContext: IMidwayContainer
  ): Promise<T> {
    const name = typeof identifier === 'string' ? identifier : identifier.name;
    identifier = currentContext.getIdentifier(identifier);
    debug('[core]: createAsync "%s(%s)"', identifier, name);

    if (currentContext.hasObject(identifier)) {
      return currentContext.getObject(identifier);
    }

    const definition = this.getObjectDefinition(identifier);

    if (
      !definition &&
      currentContext !== this.context &&
      this.context.hasObject(identifier)
    ) {
      return this.context.getObject(identifier);
    }

    if (!definition) {
      throw new MidwayDefinitionNotFoundError(identifier, name);
    }

    const creation = this.isGlobalScope(definition, currentContext)
      ? this.creating.get(definition.id)
      : undefined;
    if (creation) {
      return creation.queue
        ? this.initializeInstanceAsync(
            creation.instance,
            definition,
            creation.queue
          )
        : creation.promise;
    }

    const pendingInitQueue: PendingInitialization[] = [];
    const pendingObjectCache = new Map<string, any>();
    const ownedCreations = new Set<ObjectCreation>();
    try {
      const instance = this.createInstance(
        identifier,
        definition.name ?? name,
        args,
        definition,
        true,
        false,
        currentContext,
        pendingObjectCache,
        pendingInitQueue,
        ownedCreations
      );
      return await this.initializeInstanceAsync(
        instance,
        definition,
        pendingInitQueue
      );
    } catch (error) {
      for (const creation of ownedCreations) {
        if (!creation.initializing) this.failCreation(creation, error);
      }
      throw error;
    } finally {
      pendingObjectCache.clear();
    }
  }

  async destroyCache(): Promise<void> {
    const ids = new Set([
      ...this.context.registry.getSingletonDefinitionIds(),
      ...this.singletonCacheIds,
    ]);
    for (const key of ids) {
      const definition = this.getObjectDefinition(key);
      if (definition?.creator) {
        const inst = this.context.getObject(key);
        this.getObjectEventTarget().emit(
          ObjectLifeCycleEvent.BEFORE_DESTROY,
          inst,
          {
            context: this.context,
            definition,
          }
        );
        await definition.creator.doDestroyAsync(inst);
      }
      // clean singleton object cache
      this.context.removeObject(key);
    }

    this.creating.clear();
    this.singletonCacheIds.clear();
  }

  private getObjectEventTarget(): EventEmitter {
    return this.context.objectCreateEventTarget;
  }

  private checkSingletonInvokeRequest(definition, key, currentContext) {
    if (definition.isSingletonScope()) {
      const managedRef: PropertyInjectMetadata = definition.properties.get(key);
      if (currentContext.hasDefinition(managedRef?.id)) {
        const propertyDefinition = currentContext.getDefinition(managedRef.id);
        if (
          propertyDefinition.isRequestScope() &&
          !propertyDefinition.allowDowngrade
        ) {
          throw new MidwaySingletonInjectRequestError(
            definition.path.name,
            propertyDefinition.path.name
          );
        }
      }
    }
    return true;
  }

  private setInstanceScope(inst, scope: ScopeEnum) {
    if (inst && typeof inst === 'object') {
      if (
        scope === ScopeEnum.Request &&
        inst[REQUEST_OBJ_CTX_KEY] === SINGLETON_CONTAINER_CTX
      ) {
        scope = ScopeEnum.Singleton;
      }
      Object.defineProperty(inst, CONTAINER_OBJ_SCOPE, {
        value: scope,
        writable: false,
        enumerable: false,
        configurable: false,
      });
    }
  }

  private createInstance(
    identifier: ClassType | string,
    name: string,
    args = [],
    definition: IObjectDefinition,
    isAsync: boolean,
    isLazyInject: boolean,
    currentContext: IMidwayContainer,
    pendingObjectCache: Map<string, any>,
    pendingInitQueue: PendingInitialization[],
    ownedCreations: Set<ObjectCreation>,
    creationPath: Set<string> = new Set(),
    replaceCallback?: (newValue: any) => void
  ): any {
    identifier = currentContext.getIdentifier(identifier);
    if (currentContext.hasObject(identifier)) {
      return currentContext.getObject(identifier);
    }

    definition = definition ?? currentContext.getDefinition(identifier);

    if (
      !definition &&
      currentContext !== this.context &&
      this.context.hasObject(identifier)
    ) {
      return this.context.getObject(identifier);
    }

    if (!definition) {
      throw new MidwayDefinitionNotFoundError(
        identifier as string,
        name,
        this.translateIdentifiers(Array.from(creationPath))
      );
    }

    if (definition.isSingletonScope()) {
      currentContext = this.context;
      if (this.context.hasObject(definition.id)) {
        debug(
          `[core]: "${definition.id}(${definition.name})" get from singleton cache.`
        );
        return this.context.getObject(definition.id);
      }
    }

    // 使用 creationPath 检查循环依赖
    if (creationPath.has(definition.id)) {
      if (isLazyInject) {
        return createProxy(() => {
          return currentContext.get(definition.id);
        });
      } else {
        const cycle = Array.from(creationPath).concat(definition.id);
        throw new MidwayCommonError(
          `Circular dependency detected: ${this.translateIdentifiers(
            cycle
          ).join(' -> ')}`
        );
      }
    }

    const shared = this.isGlobalScope(definition, currentContext)
      ? this.creating.get(definition.id)
      : undefined;
    if (shared) {
      pendingInitQueue.push({
        instance: shared.instance,
        definition,
        context: currentContext,
        shared: true,
        replaceCallback,
        init: () => {
          if (shared.failure) throw shared.failure.error;
          if (shared.result) return shared.result.value;
          if (!shared.queue) return shared.promise;
          return isAsync
            ? this.initializeInstanceAsync(
                shared.instance,
                definition,
                shared.queue
              )
            : this.initializeInstance(
                shared.instance,
                definition,
                shared.queue
              );
        },
      });
      return shared.instance;
    }

    if (pendingObjectCache.has(definition.id)) {
      return pendingObjectCache.get(definition.id);
    }

    const queueStart = pendingInitQueue.length;
    const creation = this.isGlobalScope(definition, currentContext)
      ? this.reserveCreation(definition)
      : undefined;
    if (creation) ownedCreations.add(creation);
    creationPath.add(definition.id);

    // Pre-initialize dependencies
    if (definition.hasDependsOn()) {
      for (const dep of definition.dependsOn) {
        debug('[core]: id = %s init depend %s.', definition.id, dep);
        this.createInstance(
          dep as string,
          dep as string,
          [],
          undefined,
          isAsync,
          false,
          currentContext,
          pendingObjectCache,
          pendingInitQueue,
          ownedCreations,
          new Set(creationPath)
        );
      }
    }

    // Get class or function from definition
    const Clzz = definition.creator.load();

    // Get constructor args
    let constructorArgs = new Array(definition.constructorArgs.length);
    if (args && Array.isArray(args) && args.length > 0) {
      constructorArgs = args;
    } else {
      // init constructor args
      for (let i = 0; i < definition.constructorArgs.length; i++) {
        const arg = definition.constructorArgs[i];
        if (arg === undefined) continue;
        arg.id = formatObjectIdentifier(arg.id) as string;

        debug(
          '[core]: constructor arg "%s(%s)", pos=%s, in "%s".',
          arg.id,
          arg.name,
          arg.parameterIndex,
          name
        );
        constructorArgs[i] = this.createInstance(
          arg.id,
          arg.name,
          [],
          undefined,
          isAsync,
          arg.isLazyInject,
          currentContext,
          pendingObjectCache,
          pendingInitQueue,
          ownedCreations,
          new Set(creationPath)
        );
      }
    }

    // Emit before created event
    this.getObjectEventTarget().emit(
      ObjectLifeCycleEvent.BEFORE_CREATED,
      Clzz,
      {
        constructorArgs,
        context: currentContext,
      }
    );

    // Create instance
    let inst = definition.creator.doConstruct(Clzz, constructorArgs);

    if (!inst) {
      throw new MidwayCommonError(
        `${definition.id} construct return undefined`
      );
    }

    // Binding ctx object
    if (
      definition.isRequestScope() &&
      definition.constructor.name === 'ObjectDefinition'
    ) {
      debug('[core]: "%s(%s)" inject ctx', definition.id, definition.name);
      // set related ctx
      Object.defineProperty(inst, REQUEST_OBJ_CTX_KEY, {
        value: currentContext.get(REQUEST_CTX_KEY),
        writable: false,
        enumerable: false,
      });
    }

    pendingObjectCache.set(definition.id, inst);
    if (creation) creation.instance = inst;

    // Set properties
    if (definition.properties) {
      const keys = Array.from(definition.properties.keys());
      for (const key of keys) {
        this.checkSingletonInvokeRequest(definition, key, currentContext);
        const resolver: PropertyInjectMetadata = definition.properties.get(key);
        resolver.id = formatObjectIdentifier(resolver.id) as string;
        // if (
        //   resolver.injectMode === InjectModeEnum.Class &&
        //   !(this.getRootContext(currentContext)).hasDefinition(
        //     resolver.id
        //   )
        // ) {
        //   if (resolver.name === 'loggerService') {
        //     throw new MidwayInconsistentVersionError();
        //   } else {
        //     throw new MidwayMissingImportComponentError(resolver.name);
        //   }
        // }
        debug(
          '[core]: property "%s(%s)", in "%s".',
          resolver.id || resolver.name,
          resolver.name,
          name
        );
        inst[key] = this.createInstance(
          resolver.id || resolver.name,
          resolver.name,
          resolver.args,
          undefined,
          isAsync,
          resolver.isLazyInject,
          currentContext,
          pendingObjectCache,
          pendingInitQueue,
          ownedCreations,
          new Set(creationPath),
          newValue => {
            inst[key] = newValue;
          }
        );
      }
    }

    this.getObjectEventTarget().emit(ObjectLifeCycleEvent.AFTER_CREATED, inst, {
      context: currentContext,
      definition,
      replaceCallback: ins => {
        inst = ins;
      },
    });

    debug(
      '[core]: put "%s(%s)" to pending init queue.',
      definition.id,
      definition.name
    );

    // Capture the replaced instance before another resolution can reuse it.
    pendingObjectCache.set(definition.id, inst);
    if (creation) creation.instance = inst;
    pendingInitQueue.push({
      instance: inst,
      definition,
      context: currentContext,
      // Queue slices share entries, including non-singleton dependencies.
      creation: creation ?? this.createCompletion(definition),
      replaceCallback,
      init: () => {
        const creator = definition.creator;
        if (!isAsync) return creator.doInit(inst, currentContext);
        // Keep synchronous initialization synchronous, without changing the
        // public async creator API or bypassing custom creator overrides.
        if (
          creator instanceof ObjectCreator &&
          creator.doInitAsync === ObjectCreator.prototype.doInitAsync
        ) {
          return creator.initialize(inst, currentContext);
        }
        return creator.doInitAsync(inst, currentContext);
      },
    });
    if (creation) creation.queue = pendingInitQueue.slice(queueStart);

    return inst;
  }

  private initializeInstance(
    instance: any,
    targetDefinition: IObjectDefinition,
    pendingInitQueue: PendingInitialization[]
  ): any {
    const initializedInstances = new Map<string, any>();
    for (const entry of pendingInitQueue) {
      if (!initializedInstances.has(entry.definition.id)) {
        const value = this.initializeEntry(entry, false);
        initializedInstances.set(entry.definition.id, value);
      } else {
        entry.replaceCallback?.(initializedInstances.get(entry.definition.id));
      }
    }
    return initializedInstances.has(targetDefinition.id)
      ? initializedInstances.get(targetDefinition.id)
      : instance;
  }

  private async initializeInstanceAsync(
    instance: any,
    targetDefinition: IObjectDefinition,
    pendingInitQueue: PendingInitialization[]
  ): Promise<any> {
    const initializedInstances = new Map<string, any>();
    try {
      for (const entry of pendingInitQueue) {
        if (!initializedInstances.has(entry.definition.id)) {
          const value = this.initializeEntry(entry, true);
          initializedInstances.set(
            entry.definition.id,
            Types.isPromise(value) ? await value : value
          );
        } else {
          entry.replaceCallback?.(
            initializedInstances.get(entry.definition.id)
          );
        }
      }
      return initializedInstances.has(targetDefinition.id)
        ? initializedInstances.get(targetDefinition.id)
        : instance;
    } catch (error) {
      // Release entries that cannot start. An initializer already running in
      // another resolution remains responsible for its own completion.
      for (const entry of pendingInitQueue) {
        if (entry.creation && !entry.creation.initializing) {
          this.failCreation(entry.creation, error);
        }
      }
      throw error;
    }
  }

  /** Execute an owned initializer once, or wait for its existing result. */
  private initializeEntry(entry: PendingInitialization, isAsync: boolean): any {
    const { creation, definition } = entry;
    if (creation?.failure) throw creation.failure.error;
    if (creation?.result) return creation.result.value;
    if (creation?.initializing) {
      if (isAsync || definition instanceof FunctionDefinition)
        return creation.promise;
      throw new MidwayUseWrongMethodError(
        'context.get',
        'context.getAsync',
        definition.id
      );
    }
    if (creation) creation.initializing = true;

    const finish = (result: any) => {
      if (entry.shared) {
        entry.replaceCallback?.(result);
        return result;
      }
      const value =
        definition instanceof FunctionDefinition ? result : entry.instance;
      entry.replaceCallback?.(value);
      this.storeInstanceScope(value, definition, entry.context);
      this.getObjectEventTarget().emit(ObjectLifeCycleEvent.AFTER_INIT, value, {
        context: entry.context,
        definition,
      });
      if (creation) {
        creation.result = { value };
        creation.resolve(value);
        this.releaseCreation(creation);
      }
      return value;
    };

    try {
      const result = entry.init();
      if (Types.isPromise(result)) {
        if (!isAsync && !(definition instanceof FunctionDefinition)) {
          throw new MidwayUseWrongMethodError(
            'context.get',
            'context.getAsync',
            definition.id
          );
        }
        return result.then(finish).catch(error => {
          if (creation) this.failCreation(creation, error);
          throw error;
        });
      }
      return finish(result);
    } catch (error) {
      if (creation) this.failCreation(creation, error);
      throw error;
    }
  }

  /** Resolve cache ownership without promoting actual request or prototype values. */
  private isGlobalScope(
    definition: IObjectDefinition,
    context: IMidwayContainer
  ): boolean {
    return (
      definition.isSingletonScope() ||
      (definition.isRequestScope() && context === this.context)
    );
  }

  /** Reserve before calling constructors or providers, including synchronous reentry. */
  private reserveCreation(definition: IObjectDefinition): ObjectCreation {
    const creation = this.createCompletion(definition);
    this.creating.set(definition.id, creation);
    return creation;
  }

  /** Keep repeated visits to the same queue entry on one initialization. */
  private createCompletion(definition: IObjectDefinition): ObjectCreation {
    let resolve: (value: any) => void;
    let reject: (error: any) => void;
    const promise = new Promise<any>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    // A creation can fail before any waiter joins. The resolving API still
    // propagates the original error; this internal promise must be observed too.
    promise.catch(() => {});
    return { definition, promise, resolve, reject };
  }

  /** Remove only this attempt, so its cleanup cannot erase a later resolution. */
  private releaseCreation(creation: ObjectCreation): void {
    if (this.creating.get(creation.definition.id) === creation) {
      this.creating.delete(creation.definition.id);
    }
    creation.queue = undefined;
  }

  /** Reject unfinished owners and release their temporary construction records. */
  private failCreation(creation: ObjectCreation, error: any): void {
    if (creation.result || creation.failure) return;
    creation.failure = { error };
    creation.reject(error);
    this.releaseCreation(creation);
  }

  private storeInstanceScope(
    instance: any,
    definition: IObjectDefinition,
    context: IMidwayContainer
  ): void {
    if (!definition.id) return;
    if (this.isGlobalScope(definition, context)) {
      this.context.registerObject(definition.id, instance);
      this.singletonCacheIds.add(definition.id);
    } else if (definition.isRequestScope()) {
      context.registerObject(definition.id, instance);
    }
    // A factory may return an existing object, a primitive or a function.
    // Its cache ownership comes from the provider, not from mutating that value.
    if (!(definition instanceof FunctionDefinition)) {
      this.setInstanceScope(
        instance,
        definition.isSingletonScope()
          ? ScopeEnum.Singleton
          : definition.isRequestScope()
            ? ScopeEnum.Request
            : ScopeEnum.Prototype
      );
    }
  }

  private getObjectDefinition(identifier: ObjectIdentifier): IObjectDefinition {
    return this.context.getDefinition(identifier);
  }

  private translateIdentifiers(ids: string[]) {
    return ids.map(id => {
      const definition = this.context.getDefinition(id);
      return definition.path?.name ?? definition.name ?? definition.id;
    });
  }
}
