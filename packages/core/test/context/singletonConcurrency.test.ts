import {
  Destroy,
  Init,
  Inject,
  MidwayContainer,
  MidwayRequestContainer,
  MidwayPriorityManager,
  MidwaySingletonInjectRequestError,
  MidwayUseWrongMethodError,
  ServiceFactory,
  Provide,
  Scope,
  ScopeEnum,
  Singleton,
  SINGLETON_CONTAINER_CTX,
  providerWrapper,
} from '../../src';

/** A controlled initializer boundary, without timing-dependent sleeps. */
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('concurrent singleton resolution', () => {
  it.each([2, 8])(
    'shares construction and initialization across %i calls',
    async count => {
      const gate = barrier();
      const entered = barrier();
      let constructed = 0;
      let initialized = 0;
      let destroyed = 0;
      let resolved = 0;
      @Singleton()
      class Service {
        ready = false;
        constructor() {
          constructed++;
        }
        @Init()
        async init() {
          initialized++;
          entered.resolve();
          await gate.promise;
          this.ready = true;
        }
        @Destroy()
        stop() {
          destroyed++;
        }
      }
      const container = new MidwayContainer();
      container.bind(Service);
      expect(constructed).toBe(0);
      const pending = Array.from({ length: count }, () =>
        container.getAsync(Service).then(value => {
          resolved++;
          return value;
        })
      );
      try {
        await entered.promise;
        expect(resolved).toBe(0);
        expect(container.hasObject(container.getIdentifier(Service))).toBe(
          false
        );
        expect(constructed).toBe(1);
        expect(initialized).toBe(1);
      } finally {
        gate.resolve();
        const values = await Promise.all(pending);
        expect(new Set(values).size).toBe(1);
        expect(values[0].ready).toBe(true);
        expect(await container.getAsync(Service)).toBe(values[0]);
        expect(container.get(Service)).toBe(values[0]);
        await container.stop();
      }
      expect(destroyed).toBe(1);
    }
  );

  it.each(['property', 'constructor', 'dependsOn'])(
    'shares dependencies through %s resolution',
    async mode => {
      const gate = barrier();
      let constructed = 0;
      let initialized = 0;
      const order: string[] = [];
      @Singleton()
      class Dependency {
        ready = false;
        constructor() {
          constructed++;
        }
        @Init()
        async init() {
          initialized++;
          await gate.promise;
          this.ready = true;
          order.push('dependency');
        }
      }
      @Provide()
      class PropertyRoot {
        @Inject() dependency: Dependency;
        @Init()
        init() {
          expect(this.dependency.ready).toBe(true);
          order.push('root');
        }
      }
      @Provide()
      class ConstructorRoot {
        constructor(@Inject() public dependency: Dependency) {}
        @Init()
        init() {
          expect(this.dependency.ready).toBe(true);
          order.push('root');
        }
      }
      @Provide()
      class DependsOnRoot {
        @Init()
        init() {
          expect(order[0]).toBe('dependency');
          order.push('root');
        }
      }
      const container = new MidwayContainer();
      container.bind(Dependency);
      const root =
        mode === 'property'
          ? PropertyRoot
          : mode === 'constructor'
            ? ConstructorRoot
            : DependsOnRoot;
      const definition = container.bind(root);
      if (mode === 'dependsOn')
        definition.dependsOn.push(container.getIdentifier(Dependency));
      const requests = [
        new MidwayRequestContainer({}, container),
        new MidwayRequestContainer({}, container),
      ];
      const pending = requests.map(request => request.getAsync<any>(root));
      try {
        expect(constructed).toBe(1);
        expect(initialized).toBe(1);
        expect(order).toEqual([]);
      } finally {
        gate.resolve();
        const [a, b] = await Promise.all(pending);
        if (mode !== 'dependsOn') expect(a.dependency).toBe(b.dependency);
        expect(order).toEqual(['dependency', 'root', 'root']);
        await container.stop();
      }
    }
  );

  it.each(['global', 'downgrade'])(
    'shares effective singletons from %s resolution',
    async mode => {
      const gate = barrier();
      let initialized = 0;
      let destroyed = 0;
      @Provide()
      @Scope(ScopeEnum.Request, { allowDowngrade: true })
      class Dependency {
        @Inject() ctx;
        @Init()
        async init() {
          initialized++;
          await gate.promise;
        }
        @Destroy()
        destroy() {
          destroyed++;
        }
      }
      @Singleton()
      class A {
        @Inject() dependency: Dependency;
      }
      @Singleton()
      class B {
        @Inject() dependency: Dependency;
      }
      const container = new MidwayContainer();
      container.bind(Dependency);
      container.bind(A);
      container.bind(B);
      const req1 = new MidwayRequestContainer({ request: 1 }, container);
      const req2 = new MidwayRequestContainer({ request: 2 }, container);
      const pending =
        mode === 'global'
          ? [container.getAsync(Dependency), container.getAsync(Dependency)]
          : [
              req1.getAsync(A).then(value => value.dependency),
              req2.getAsync(B).then(value => value.dependency),
            ];
      gate.resolve();
      try {
        const [a, b] = await Promise.all(pending);
        expect(a).toBe(b);
        expect(initialized).toBe(1);
        expect(a.ctx).toBe(SINGLETON_CONTAINER_CTX);
        expect(container.getInstanceScope(a)).toBe(ScopeEnum.Singleton);
        const requestValue = await req1.getAsync(Dependency);
        expect(requestValue).not.toBe(a);
        expect(requestValue.ctx.request).toBe(1);
        expect(container.getInstanceScope(requestValue)).toBe(
          ScopeEnum.Request
        );
      } finally {
        await container.stop();
      }
      expect(destroyed).toBe(1);
    }
  );

  it.each(['sync', 'async', 'callback', 'value'])(
    'caches the result of a %s singleton provider',
    async mode => {
      const gate = barrier();
      let invoked = 0;
      const result =
        mode === 'callback'
          ? (value: number) => value + 1
          : mode === 'value'
            ? 42
            : { ready: true };
      const provider =
        mode === 'async'
          ? async () => {
              invoked++;
              await gate.promise;
              return result;
            }
          : () => {
              invoked++;
              return result;
            };
      providerWrapper([
        { id: 'factory', provider, scope: ScopeEnum.Singleton },
      ]);
      @Provide()
      class Consumer {
        @Inject('factory') value: any;
      }
      const container = new MidwayContainer();
      container.bind(provider, {});
      container.bind(Consumer);
      const req = new MidwayRequestContainer({}, container);
      const pending = [
        container.getAsync('factory'),
        req.getAsync(Consumer).then(value => value.value),
      ];
      gate.resolve();
      try {
        const values = await Promise.all(pending);
        expect(invoked).toBe(1);
        for (const value of values) expect(value).toBe(result);
        expect(await container.getAsync('factory')).toBe(result);
        expect(container.get('factory')).toBe(result);
        expect(await req.getAsync('factory')).toBe(result);
        expect(req.get('factory')).toBe(result);
        if (typeof result === 'function') {
          expect(result(1)).toBe(2);
          expect(result(2)).toBe(3);
          expect(invoked).toBe(1);
        }
      } finally {
        await container.stop();
      }
    }
  );

  it.each([false, true])(
    'preserves synchronous get after getAsync (Init: %s)',
    withInit => {
      let constructed = 0;
      let initialized = 0;
      @Singleton()
      class Service {
        constructor() {
          constructed++;
        }
        init() {
          initialized++;
        }
      }
      if (withInit)
        Init()(
          Service.prototype,
          'init',
          Object.getOwnPropertyDescriptor(Service.prototype, 'init')
        );
      const container = new MidwayContainer();
      container.bind(Service);
      const pending = container.getAsync(Service);
      const value = container.get(Service);
      return pending.then(async resolved => {
        expect(resolved).toBe(value);
        expect(constructed).toBe(1);
        expect(initialized).toBe(withInit ? 1 : 0);
        await container.stop();
      });
    }
  );

  it('releases failed initialization and preserves later resolution', async () => {
    const gate = barrier();
    const failure = new Error('initialization failed');
    let attempts = 0;
    @Singleton()
    class Service {
      @Init()
      async init() {
        const attempt = ++attempts;
        await gate.promise;
        if (attempt === 1) throw failure;
      }
    }
    const container = new MidwayContainer();
    container.bind(Service);
    const pending = Promise.allSettled([
      container.getAsync(Service),
      container.getAsync(Service),
    ]);
    gate.resolve();
    try {
      const values = await pending;
      expect(values).toEqual([
        { status: 'rejected', reason: failure },
        { status: 'rejected', reason: failure },
      ]);
      expect(container.hasObject(container.getIdentifier(Service))).toBe(false);
      const [a, b] = await Promise.all([
        container.getAsync(Service),
        container.getAsync(Service),
      ]);
      expect(a).toBe(b);
      expect(attempts).toBe(2);
    } finally {
      await container.stop();
    }
  });

  it('shares aliases across requests while keeping global containers independent', async () => {
    const gate = barrier();
    let constructed = 0;
    @Provide('shared')
    @Scope(ScopeEnum.Singleton)
    class Service {
      @Inject() ctx;
      constructor() {
        constructed++;
      }
      @Init()
      async init() {
        await gate.promise;
      }
    }
    const first = new MidwayContainer();
    const second = new MidwayContainer();
    first.bind(Service);
    second.bind(Service);
    const request = new MidwayRequestContainer({ request: true }, first);
    const pending = [
      first.getAsync(Service),
      request.getAsync<Service>('shared'),
      second.getAsync(Service),
    ];
    gate.resolve();
    try {
      const [a, b, c] = await Promise.all(pending);
      expect(a).toBe(b);
      expect(c).not.toBe(a);
      expect(constructed).toBe(2);
      expect(b.ctx).toBe(SINGLETON_CONTAINER_CTX);
    } finally {
      await first.stop();
      await second.stop();
    }
  });
  it('allows unrelated initializers to make progress concurrently', async () => {
    const gate = barrier();
    const started: string[] = [];
    @Singleton()
    class A {
      @Init() async init() {
        started.push('A');
        await gate.promise;
      }
    }
    @Singleton()
    class B {
      @Init() async init() {
        started.push('B');
        await gate.promise;
      }
    }
    const container = new MidwayContainer();
    container.bind(A);
    container.bind(B);
    const pending = [container.getAsync(A), container.getAsync(B)];
    try {
      expect(started).toEqual(['A', 'B']);
    } finally {
      gate.resolve();
      await Promise.all(pending);
      await container.stop();
    }
  });

  it('reserves a singleton before its constructor reenters getAsync', async () => {
    const container = new MidwayContainer();
    let reentered: Promise<Service>;
    let constructed = 0;
    @Singleton()
    class Service {
      constructor() {
        constructed++;
        reentered = container.getAsync(Service);
      }
    }
    container.bind(Service);
    try {
      const value = await container.getAsync(Service);
      expect(await reentered).toBe(value);
      expect(constructed).toBe(1);
    } finally {
      await container.stop();
    }
  });

  it('releases reservations when construction or dependency resolution fails', async () => {
    const failure = new Error('constructor failed');
    let attempts = 0;
    @Singleton()
    class Service {
      constructor() {
        if (++attempts === 1) throw failure;
      }
    }
    @Singleton()
    class Root {
      @Inject() service: Service;
      @Inject('missing') missing;
    }
    const container = new MidwayContainer();
    container.bind(Service);
    container.bind(Root);
    try {
      await expect(container.getAsync(Service)).rejects.toBe(failure);
      await expect(container.getAsync(Root)).rejects.toThrow('missing');
      container.registerObject('missing', 'available');
      const [a, b] = await Promise.all([
        container.getAsync(Root),
        container.getAsync(Root),
      ]);
      expect(a).toBe(b);
      expect(a.service).toBe(await container.getAsync(Service));
      expect(attempts).toBe(3);
    } finally {
      await container.stop();
    }
  });

  it('keeps initialized dependencies after their parent initializer fails', async () => {
    let dependencyInitializations = 0;
    let parentInitializations = 0;
    @Singleton()
    class Dependency {
      @Init() init() {
        dependencyInitializations++;
      }
    }
    @Singleton()
    class Root {
      @Inject() dependency: Dependency;
      @Init() init() {
        if (++parentInitializations === 1) throw new Error('parent failed');
      }
    }
    const container = new MidwayContainer();
    container.bind(Dependency);
    container.bind(Root);
    try {
      await expect(container.getAsync(Root)).rejects.toThrow('parent failed');
      const value = await container.getAsync(Root);
      expect(value.dependency).toBe(container.get(Dependency));
      expect(dependencyInitializations).toBe(1);
      expect(parentInitializations).toBe(2);
    } finally {
      await container.stop();
    }
  });

  it('does not discard a separately initializing sibling when the root fails', async () => {
    const failedGate = barrier();
    const sharedGate = barrier();
    let constructed = 0;
    @Singleton()
    class Failed {
      @Init() async init() {
        await failedGate.promise;
        throw new Error('failed');
      }
    }
    @Singleton()
    class Shared {
      constructor() {
        constructed++;
      }
      @Init() async init() {
        await sharedGate.promise;
      }
    }
    @Singleton()
    class Root {
      @Inject() failed: Failed;
      @Inject() shared: Shared;
    }
    const container = new MidwayContainer();
    container.bind(Failed);
    container.bind(Shared);
    container.bind(Root);
    const failed = container.getAsync(Root);
    const first = container.getAsync(Shared);
    failedGate.resolve();
    try {
      await expect(failed).rejects.toThrow('failed');
      const second = container.getAsync(Shared);
      sharedGate.resolve();
      const [a, b] = await Promise.all([first, second]);
      expect(a).toBe(b);
      expect(constructed).toBe(1);
    } finally {
      sharedGate.resolve();
      await container.stop();
    }
  });

  it('shares callback-style initialization until its callback completes', async () => {
    let complete: () => void;
    let initialized = 0;
    @Singleton()
    class Service {
      @Init() init(done: () => void) {
        initialized++;
        complete = done;
      }
    }
    const container = new MidwayContainer();
    container.bind(Service);
    const pending = [container.getAsync(Service), container.getAsync(Service)];
    complete();
    try {
      const [a, b] = await Promise.all(pending);
      expect(a).toBe(b);
      expect(initialized).toBe(1);
    } finally {
      await container.stop();
    }
  });

  it('initializes a queued singleton requested from another initializer', async () => {
    const container = new MidwayContainer();
    let initialized = 0;
    @Singleton()
    class Dependency {
      @Init() async init() {
        initialized++;
      }
    }
    @Singleton()
    class A {
      dependency: Dependency;
      @Init() async init() {
        this.dependency = await container.getAsync(Dependency);
      }
    }
    @Singleton()
    class Root {
      @Inject() a: A;
      @Inject() dependency: Dependency;
    }
    container.bind(Dependency);
    container.bind(A);
    container.bind(Root);
    try {
      const root = await container.getAsync(Root);
      expect(root.a.dependency).toBe(root.dependency);
      expect(initialized).toBe(1);
    } finally {
      await container.stop();
    }
  });

  it('shares the final replacement and emits lifecycle events once', async () => {
    const gate = barrier();
    const events: string[] = [];
    let replacement: Service;
    @Singleton()
    class Service {
      ready = false;
      @Init() async init() {
        await gate.promise;
        this.ready = true;
      }
      @Destroy() destroy() {
        events.push('destroy');
      }
    }
    const container = new MidwayContainer();
    container.bind(Service);
    container.onBeforeObjectCreated(() => events.push('beforeCreate'));
    container.onObjectCreated((instance, options) => {
      events.push('created');
      replacement = new Proxy(instance as Service, {});
      options.replaceCallback(replacement);
    });
    container.onObjectInit(instance => {
      expect(instance).toBe(replacement);
      events.push('initialized');
    });
    container.onBeforeObjectDestroy(instance => {
      expect(instance).toBe(replacement);
      events.push('beforeDestroy');
    });
    const pending = [container.getAsync(Service), container.getAsync(Service)];
    gate.resolve();
    try {
      const [a, b] = await Promise.all(pending);
      expect(a).toBe(replacement);
      expect(b).toBe(replacement);
      expect(a.ready).toBe(true);
    } finally {
      await container.stop();
    }
    expect(events).toEqual([
      'beforeCreate',
      'created',
      'initialized',
      'beforeDestroy',
      'destroy',
    ]);
  });

  it('does not bypass illegal scope injection when a global dependency is pending', async () => {
    const gate = barrier();
    @Provide()
    class Dependency {
      @Init() async init() {
        await gate.promise;
      }
    }
    @Singleton()
    class Root {
      @Inject() dependency: Dependency;
    }
    const container = new MidwayContainer();
    container.bind(Dependency);
    container.bind(Root);
    const pending = container.getAsync(Dependency);
    try {
      await expect(container.getAsync(Root)).rejects.toBeInstanceOf(
        MidwaySingletonInjectRequestError
      );
    } finally {
      gate.resolve();
      await pending;
      await container.stop();
    }
  });

  it('initializes a prototype dependency once when its singleton owner is shared', async () => {
    const gate = barrier();
    let initialized = 0;
    @Provide()
    @Scope(ScopeEnum.Prototype)
    class Dependency {
      @Init() async init() {
        initialized++;
        await gate.promise;
      }
    }
    @Singleton()
    class Service {
      @Inject() dependency: Dependency;
    }
    const container = new MidwayContainer();
    container.bind(Dependency);
    container.bind(Service);
    const pending = [container.getAsync(Service), container.getAsync(Service)];
    gate.resolve();
    try {
      const [a, b] = await Promise.all(pending);
      expect(a).toBe(b);
      expect(initialized).toBe(1);
      expect(await container.getAsync(Dependency)).not.toBe(a.dependency);
      expect(initialized).toBe(2);
    } finally {
      await container.stop();
    }
  });

  it('preserves the error for synchronously resolving an async initializer without rerunning it', async () => {
    const gate = barrier();
    let initialized = 0;
    @Singleton()
    class Service {
      @Init() async init() {
        initialized++;
        await gate.promise;
      }
    }
    const container = new MidwayContainer();
    container.bind(Service);
    const pending = container.getAsync(Service);
    try {
      expect(() => container.get(Service)).toThrow(MidwayUseWrongMethodError);
      expect(initialized).toBe(1);
    } finally {
      gate.resolve();
      await pending;
      await container.stop();
    }
  });

  it('keeps the promise returned by synchronous get of an async function provider', async () => {
    const gate = barrier();
    const value = {};
    let invoked = 0;
    const container = new MidwayContainer();
    container.bind(
      'factory',
      async () => {
        invoked++;
        await gate.promise;
        return value;
      },
      { scope: ScopeEnum.Singleton }
    );
    const first = container.get<Promise<object>>('factory');
    const second = container.getAsync('factory');
    gate.resolve();
    try {
      expect(await first).toBe(value);
      expect(await second).toBe(value);
      expect(container.get('factory')).toBe(value);
      expect(invoked).toBe(1);
    } finally {
      await container.stop();
    }
  });

  it('releases a failed async provider resolved only through synchronous get', async () => {
    const failure = new Error('provider failed');
    let invoked = 0;
    const container = new MidwayContainer();
    const value = {};
    container.bind(
      'factory',
      async () => {
        if (++invoked === 1) throw failure;
        return value;
      },
      { scope: ScopeEnum.Singleton }
    );
    try {
      await expect(container.get<Promise<object>>('factory')).rejects.toBe(
        failure
      );
      expect(await container.getAsync('factory')).toBe(value);
      expect(invoked).toBe(2);
    } finally {
      await container.stop();
    }
  });

  it('constructs a singleton ServiceFactory once and preserves explicit client shutdown', async () => {
    const gate = barrier();
    let constructed = 0;
    let clients = 0;
    let destroyed = 0;
    @Singleton()
    class Factory extends ServiceFactory<object> {
      constructor() {
        super();
        constructed++;
      }
      @Init() async init() {
        await this.initClients({ clients: { default: {} } });
      }
      protected async createClient() {
        clients++;
        await gate.promise;
        return {};
      }
      protected async destroyClient() {
        destroyed++;
      }
      getName() {
        return 'test';
      }
    }
    const container = new MidwayContainer();
    container.bind(MidwayPriorityManager);
    container.bind(Factory);
    const pending = [container.getAsync(Factory), container.getAsync(Factory)];
    gate.resolve();
    try {
      const [a, b] = await Promise.all(pending);
      expect(a).toBe(b);
      expect(a.get()).toBe(b.get());
      expect(constructed).toBe(1);
      expect(clients).toBe(1);
      await a.stop();
      expect(destroyed).toBe(1);
    } finally {
      await container.stop();
    }
    expect(destroyed).toBe(1);
  });
});
