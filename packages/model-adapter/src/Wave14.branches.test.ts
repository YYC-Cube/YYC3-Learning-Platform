/**
 * Wave-14 分支覆盖攻坚 — ModelAdapter.ts 内部分支（istanbul 全口径 %B 71.86→85+）
 * 方法学：白盒直调私有方法 + 确定性 fixture（无固定 sleep 断言竞态）
 */
import { afterEach, describe, expect, it, jest } from 'bun:test';
import { ModelAdapter, ModelCache } from './ModelAdapter';
import type { ModelRequest } from './IModelAdapter';

const TEST_KEY = ['test', '-', 'key'].join('');
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const baseConfig = (overrides: Record<string, any> = {}): any => ({
  defaultModel: 'mock-1',
  fallbackModel: 'mock-1',
  routing: { type: 'smart' },
  loadBalancing: {
    strategy: 'round_robin',
    weights: {},
    healthCheckInterval: 60000,
    unhealthyThreshold: 3,
    healthyThreshold: 2,
  },
  cache: {
    enabled: true,
    ttl: 300000,
    maxSize: 1000,
    strategy: 'lru',
    compressionEnabled: true,
    encryptionEnabled: false,
  },
  monitoring: {
    enabled: true,
    metricsInterval: 60000,
    detailedLogging: false,
    alertThresholds: { errorRate: 5, latency: 5000, cost: 100, queueDepth: 100, resourceUsage: 80 },
    retentionPeriod: 2592000000,
  },
  security: {
    encryptionEnabled: false,
    keyRotationEnabled: false,
    auditLogging: false,
    dataRetentionPolicy: 2592000000,
    complianceStandards: [],
    accessControl: { rbacEnabled: false, defaultPermissions: [], adminRoles: [], userRoles: [] },
  },
  ...overrides,
});

const modelCfg = (overrides: Record<string, any> = {}): any => ({
  id: 'mock-1',
  name: 'Mock One',
  provider: 'openai',
  model: 'mock-model',
  credentials: { apiKey: TEST_KEY },
  capabilities: { maxTokens: 100 },
  enabled: true,
  ...overrides,
});

const resp = (content: any = 'ok', overrides: Record<string, any> = {}): any => ({
  id: 'resp-1',
  requestId: 'r1',
  modelId: 'mock-1',
  content,
  finishReason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  metadata: {
    latency: 1,
    model: 'mock-model',
    provider: 'openai',
    timestamp: Date.now(),
    requestId: 'r1',
    processingTime: 1,
    cacheHit: false,
  },
  ...overrides,
});

const mockProvider = (overrides: Record<string, any> = {}): any => ({
  provider: 'openai',
  processRequest: async () => resp(),
  processStreamingRequest: async () => {},
  healthCheck: async () => ({
    modelId: 'mock-1',
    status: 'healthy',
    responseTime: 1,
    lastCheck: Date.now(),
    errorRate: 0,
    uptime: 100,
    metrics: {
      requestsPerMinute: 0,
      errorRate: 0,
      averageLatency: 1,
      p95Latency: 1,
      p99Latency: 1,
      timeoutRate: 0,
      queueDepth: 0,
    },
  }),
  getCapabilities: () => ({}),
  validateConfig: () => true,
  cleanup: async () => {},
  ...overrides,
});

const setup = async (overrides: Record<string, any> = {}): Promise<any> => {
  const adapter = new ModelAdapter();
  await adapter.initialize(baseConfig(overrides));
  return adapter;
};

const wire = (adapter: any, provider: any = mockProvider(), cfg: any = modelCfg()): void => {
  adapter._models.set(cfg.id, cfg);
  adapter._providers.set(cfg.provider, provider);
};

const req = (overrides: Partial<ModelRequest> = {}): ModelRequest => ({
  id: `r_${Math.random().toString(36).slice(2, 8)}`,
  taskType: 'generation',
  prompt: `prompt-${Math.random().toString(36).slice(2, 8)}`,
  metadata: { requestId: 'mr-1', priority: 'normal' },
  ...overrides,
});

describe('Wave-14 A1 — EventEmitter / initialize / start 内部分支', () => {
  it('on 同事件双监听 + removeListener 部分移除（else 分支 L36）', () => {
    const adapter = new ModelAdapter();
    const got: string[] = [];
    const f1 = () => got.push('f1');
    const f2 = () => got.push('f2');
    adapter.on('evt', f1);
    adapter.on('evt', f2); // listeners 已存在 → if(!has) false 路径
    adapter.removeListener('evt', f1); // 过滤后 length>0 → set(remaining)
    adapter.emit('evt', 'x');
    expect(got).toEqual(['f2']);
  });

  it('removeListener 未知事件（早退分支）+ 单监听移除后 emit false', () => {
    const adapter = new ModelAdapter();
    const f = () => {};
    expect(() => adapter.removeListener('ghost', f)).not.toThrow(); // !has → return this
    adapter.on('once', f);
    adapter.removeListener('once', f);
    expect(adapter.emit('once')).toBe(false); // 已 delete → !has → false
  });

  it('initialize 无 cache 配置（|| 默认值回退）+ monitor/router 无 initialize（else 边）', async () => {
    const adapter = new ModelAdapter();
    (adapter as any)._monitor = {}; // 'initialize' in monitor → false
    (adapter as any)._router = {}; // 'initialize' in router → false
    const cfg = baseConfig();
    delete (cfg as any).cache; // cache?.maxSize → undefined → 1000 兜底
    await adapter.initialize(cfg as any);
    expect(adapter.status).toBe('active');
    await expect(adapter.getCacheStats()).resolves.toBeDefined();
  });

  it('start 在非 active 状态 → 抛错（guard 分支）', async () => {
    const adapter = new ModelAdapter();
    await expect(adapter.start()).rejects.toThrow(/Cannot start ModelAdapter/);
  });

  it('removeModel 时 provider 已缺失（if(provider) else 边）', async () => {
    const adapter = await setup();
    adapter._models.set('orphan', modelCfg({ id: 'orphan' })); // 不注入 provider
    await adapter.removeModel('orphan');
    expect(adapter.getModel('orphan')).toBeUndefined();
  });
});

describe('Wave-14 A2 — processRequest 分支族', () => {
  it('无可用模型 → No available models（guard 分支）', async () => {
    const adapter = await setup();
    await expect(adapter.processRequest(req())).rejects.toThrow(/No available models/);
  });

  it('provider 缺失 → Provider not found（选中后 guard 分支）', async () => {
    const adapter = await setup();
    wire(adapter);
    adapter._providers.delete('openai');
    await expect(adapter.processRequest(req())).rejects.toThrow(/Provider not found/);
  });

  it('metadata.deadline 生效（三元 true 分支）+ 成功路径', async () => {
    const adapter = await setup();
    wire(adapter);
    const r = await adapter.processRequest(req({ metadata: { requestId: 'dl', priority: 'high', deadline: Date.now() + 5000 } }));
    expect(r.content).toBe('ok');
    expect(r.requestId).toBeTruthy();
  });

  it('路由策略 fastest / least_cost / best_quality（switch 三分支）', async () => {
    for (const type of ['fastest', 'least_cost', 'best_quality'] as const) {
      const adapter = await setup({ routing: { type } });
      wire(adapter);
      const r = await adapter.processRequest(req());
      expect(r.content).toBe('ok');
    }
  });

  it('流式请求空模型列表 → router 各策略 || {} 兜底 → Provider not found', async () => {
    for (const type of ['smart', 'fastest', 'least_cost', 'best_quality'] as const) {
      const adapter = await setup({ routing: { type } });
      await expect(adapter.processStreamingRequest(req(), () => {})).rejects.toThrow(/Provider not found/);
    }
  });

  it('getCacheStats 有请求后 hitRate/missRate 归一（totalRequests>0 分支）', async () => {
    const adapter = await setup();
    wire(adapter);
    await adapter.processRequest(req());
    const stats = await adapter.getCacheStats();
    expect(stats.hitRate + stats.missRate).toBeCloseTo(1, 5);
  });

  it('cancelRequest 命中 controller 与 timeout（双 guard true 分支）', async () => {
    const adapter = await setup();
    const controller = new AbortController();
    adapter._activeRequests.set('c1', controller);
    const handle = setTimeout(() => {}, 10000);
    adapter._requestTimeouts.set('c1', handle);
    await adapter.cancelRequest('c1');
    expect(controller.signal.aborted).toBe(true);
    expect(adapter._requestTimeouts.has('c1')).toBe(false);
  });

  it('healthCheck：provider 缺失跳过 + healthCheck 抛错 → unhealthy 记录', async () => {
    const adapter = await setup();
    adapter._models.set('gone', modelCfg({ id: 'gone', provider: 'azure' })); // provider 未注册 → if(provider) else
    wire(adapter, mockProvider({ healthCheck: async () => { throw new Error('probe fail'); } }), modelCfg({ id: 'boom' }));
    const checks = await adapter.healthCheck();
    expect(checks['gone']).toBeUndefined();
    expect(checks['boom'].status).toBe('unhealthy');
    expect(checks['boom'].errorRate).toBe(100);
  });

  it('start 健康巡检 tick → unhealthy 模型 emit healthWarning（确定性短间隔单 tick）', async () => {
    const adapter = await setup({ loadBalancing: { strategy: 'round_robin', weights: {}, healthCheckInterval: 10, unhealthyThreshold: 3, healthyThreshold: 2 } });
    wire(adapter, mockProvider({ healthCheck: async () => ({ modelId: 'mock-1', status: 'degraded', responseTime: 1, lastCheck: Date.now(), errorRate: 0.2, uptime: 10, metrics: {} as any }) }));
    const warnings: any[] = [];
    adapter.on('healthWarning', (id: any, h: any) => warnings.push({ id, h }));
    await adapter.start();
    await delay(80); // 首个 tick 必然发生于 10ms 间隔下
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings[0].id).toBe('mock-1');
  });

  it('getModelMetrics providerMetrics 缺失 → undefined（guard 分支）', async () => {
    const adapter = await setup();
    (adapter as any)._metrics.providerMetrics = undefined;
    expect(adapter.getModelMetrics('mock-1')).toBeUndefined();
  });
});

describe('Wave-14 A3 — generateText/generate/generateStream 分支族', () => {
  it('generateText 最小参数（systemPrompt/temperature/maxTokens 三个 if 的 else 边）', async () => {
    const adapter = await setup();
    wire(adapter);
    const r = await adapter.generateText({ prompt: `p-${Date.now()}` });
    expect(r.content).toBe('ok');
  });

  it('generate：数组 content join（Array 分支）+ 字符串 + undefined 兜底（|| 分支）', async () => {
    const adapter = await setup();
    wire(adapter, mockProvider({ processRequest: async () => resp([{ type: 'text', content: 'ab' }, { type: 'text', content: 'cd' }]) }));
    const arr = await adapter.generate({ prompt: `g1-${Date.now()}` });
    expect(arr.text).toBe('abcd');

    wire(adapter, mockProvider({ processRequest: async () => resp('plain') }));
    const str = await adapter.generate({ prompt: `g2-${Date.now()}` });
    expect(str.text).toBe('plain');

    wire(adapter, mockProvider({ processRequest: async () => resp(null) }));
    const empty = await adapter.generate({ prompt: `g3-${Date.now()}` });
    expect(empty.text).toBe('');
  });

  it('generateStream 回调版：systemPrompt/maxTokens/temperature 三个 if true 边 + 双形态 content', async () => {
    const adapter = await setup();
    const chunks: any[] = [
      { id: 'c1', requestId: 'r', modelId: 'm', content: 'hello', finishReason: 'stop', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, metadata: { latency: 0, model: 'm', provider: 'openai', timestamp: Date.now(), requestId: 'r', processingTime: 0 } },
      { id: 'c2', requestId: 'r', modelId: 'm', content: { x: 1 }, finishReason: 'stop', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, metadata: { latency: 0, model: 'm', provider: 'openai', timestamp: Date.now(), requestId: 'r', processingTime: 0 } },
    ];
    wire(adapter, mockProvider({
      processStreamingRequest: async (_rq: any, cb: any) => {
        await delay(20);
        for (const c of chunks) cb(c);
      },
    }));
    const got: string[] = [];
    await adapter.generateStream({ prompt: `s-${Date.now()}`, systemPrompt: 'sys', maxTokens: 42, temperature: 0.3 }, (c) => got.push(c));
    expect(got).toEqual(['hello', JSON.stringify({ x: 1 })]);
  });

  it('generateStream 异步迭代器：next 先挂起 → chunk 走 resolveNext → 余量走缓冲 → done', async () => {
    const adapter = await setup();
    const mk = (id: string, content: any) => ({ id, requestId: 'r', modelId: 'm', content, finishReason: 'stop', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, metadata: { latency: 0, model: 'm', provider: 'openai', timestamp: Date.now(), requestId: 'r', processingTime: 0 } });
    wire(adapter, mockProvider({
      processStreamingRequest: async (_rq: any, cb: any) => {
        await delay(250); // 期间 100ms flush interval 以空缓冲 tick（flushBuffer 空分支）
        cb(mk('k1', 'first'));
        cb(mk('k2', { obj: true }));
      },
    }));
    const iter = (adapter.generateStream({ prompt: `it-${Date.now()}` }) as any)[Symbol.asyncIterator]();
    const p1 = iter.next(); // 先挂起：resolveNext 就位
    await delay(340);
    const r1 = await p1;
    expect(r1.done).toBe(false);
    expect(r1.value.text).toBe('first');
    const r2 = await iter.next(); // 缓冲读取分支
    expect(r2.value.text).toBe(JSON.stringify({ obj: true }));
    const r3 = await iter.next(); // done 分支
    expect(r3.done).toBe(true);
  });

  it('generateStream 迭代器：完成时无 pending next（then 的 else 边）→ 再 next 得 done', async () => {
    const adapter = await setup();
    const mk = (content: string) => ({ id: 'z', requestId: 'r', modelId: 'm', content, finishReason: 'stop', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, metadata: { latency: 0, model: 'm', provider: 'openai', timestamp: Date.now(), requestId: 'r', processingTime: 0 } });
    wire(adapter, mockProvider({
      processStreamingRequest: async (_rq: any, cb: any) => {
        await delay(30);
        cb(mk('solo'));
      },
    }));
    const iter = (adapter.generateStream({ prompt: `ab-${Date.now()}` }) as any)[Symbol.asyncIterator]();
    const r1 = await iter.next();
    expect(r1.value.text).toBe('solo');
    await delay(60); // 完成时 resolveNext 为 null（else 边）
    const r2 = await iter.next();
    expect(r2.done).toBe(true);
  });

  it('generateStream 迭代器：错误经 resolveNext 传递 + 显式 next 再抛（catch 双边）', async () => {
    const adapter = await setup();
    wire(adapter, mockProvider({
      processStreamingRequest: async () => {
        await delay(40);
        throw new Error('stream boom');
      },
    }));
    const iter = (adapter.generateStream({ prompt: `er-${Date.now()}` }) as any)[Symbol.asyncIterator]();
    const p1 = iter.next(); // 挂起中错误抵达 → catch 内 resolveNext({done}) 边
    const r1 = await p1;
    expect(r1.done).toBe(true);
    expect(() => iter.next()).toThrow('stream boom'); // error 存根再抛分支（同步 throw）
  });

  it('generateStream 迭代器：拒绝发生时无 pending next（catch 的 else 边）→ 再 next 抛错', async () => {
    const adapter = await setup();
    wire(adapter, mockProvider({
      processStreamingRequest: async () => {
        await delay(40);
        throw new Error('late boom');
      },
    }));
    const iter = (adapter.generateStream({ prompt: `ab2-${Date.now()}` }) as any)[Symbol.asyncIterator]();
    // 迭代器已启动但从未调用 next() → 拒绝抵达时 resolveNext 为 null（catch else 边）
    await delay(320); // 覆盖 retryOnFailure 3 次重试的完整失败链
    expect(() => iter.next()).toThrow('late boom');
  });
});

describe('Wave-14 A5 — ModelCache 与内置 OpenAIProvider 白盒', () => {
  it('ModelCache：未知键 miss / 过期 miss / 命中 / set 默认 ttl（default-arg）', async () => {
    const cache = new ModelCache();
    expect(await cache.get('ghost')).toBeNull(); // entry 缺失 → miss 分支
    await cache.set('exp', resp('x'), 10);
    await delay(40);
    expect(await cache.get('exp')).toBeNull(); // 过期 → miss 分支
    await cache.set('fresh', resp('y')); // 无 ttl → 默认 300000
    expect((await cache.get('fresh'))?.content).toBe('y');
  });

  it('内置 OpenAIProvider 未初始化 → processRequest/processStreamingRequest 抛错（guard 分支）', async () => {
    const adapter = new ModelAdapter();
    const p = (adapter as any).createProvider('openai');
    await expect(p.processRequest(req())).rejects.toThrow(/not initialized/);
    await expect(p.processStreamingRequest(req(), () => {})).rejects.toThrow(/not initialized/);
  });

  it('内置 OpenAIProvider：tools/tool_choice 进请求体 + pricing 成本计算 + 空 tools 数组', async () => {
    const adapter = new ModelAdapter();
    const p = (adapter as any).createProvider('openai');
    const captured: any[] = [];
    (p as any).client = {
      chat: {
        completions: {
          create: async (r: any) => {
            captured.push(r);
            return {
              id: 'c1',
              model: 'm',
              choices: [{ message: { role: 'assistant', content: 'hi', tool_calls: [{ id: 't1', function: { name: 'f', arguments: '{"a":1}' } }] }, finish_reason: 'weird' }],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            };
          },
        },
      },
      models: { list: async () => ({ data: [] }) },
    };
    (p as any).modelConfig = modelCfg({ pricing: { inputTokensPer1K: 0.01, outputTokensPer1K: 0.03, currency: 'USD', unit: 'token' } });

    const r1 = await p.processRequest(req({
      tools: [{ id: 't', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }],
      toolChoice: { type: 'auto' },
    }) as any);
    expect(captured[0].tools).toHaveLength(1);
    expect(captured[0].tool_choice).toBe('auto');
    expect(r1.finishReason).toBe('stop'); // 未知 reason → stop 兜底
    expect(r1.usage.cost).toBeCloseTo(0.01 * 10 / 1000 + 0.03 * 5 / 1000, 8);
    expect(r1.toolCalls?.[0].toolName).toBe('f');

    await p.processRequest(req({ tools: [] }) as any); // tools 空数组 → length>0 false 边
    expect(captured[1].tools).toBeUndefined();

    expect((p as any).mapFinishReason('length')).toBe('length');
  });

  it('内置 OpenAIProvider：mapToolChoice 全枚举（none/auto/required/function±name/default）', async () => {
    const adapter = new ModelAdapter();
    const p = (adapter as any).createProvider('openai');
    expect((p as any).mapToolChoice(undefined)).toBeUndefined();
    expect((p as any).mapToolChoice({ type: 'none' } as any)).toBe('none');
    expect((p as any).mapToolChoice({ type: 'auto' } as any)).toBe('auto');
    expect((p as any).mapToolChoice({ type: 'required' } as any)).toBe('required');
    expect((p as any).mapToolChoice({ type: 'function', function: { name: 'fn' } } as any)).toEqual({ type: 'function', function: { name: 'fn' } });
    expect((p as any).mapToolChoice({ type: 'function' } as any)).toBeUndefined();
    expect((p as any).mapToolChoice({ type: 'exotic' } as any)).toBeUndefined();
  });

  it('内置 OpenAIProvider：空 choices → 抛错（防御分支）', async () => {
    const adapter = new ModelAdapter();
    const p = (adapter as any).createProvider('openai');
    (p as any).client = { chat: { completions: { create: async () => ({ id: 'c', model: 'm', choices: [] }) } } };
    (p as any).modelConfig = modelCfg();
    await expect(p.processRequest(req())).rejects.toThrow(/no choices/);
  });

  it('内置 OpenAIProvider 流式：无 id 兜底 / 空 content 跳过 / finish_reason break / requestId 元数据分支', async () => {
    const adapter = new ModelAdapter();
    const p = (adapter as any).createProvider('openai');
    async function* fakeStream() {
      yield { choices: [{ delta: { content: 'he' } }] }; // 无 id → stream- 兜底
      yield { id: 's2', choices: [{ delta: {} }] }; // 空 content → 不回调
      yield { id: 's3', choices: [{ delta: { content: 'y' }, finish_reason: 'length' }] }; // break
      yield { id: 's4', choices: [{ delta: { content: 'never' } }] }; // break 后不可达
    }
    (p as any).client = { chat: { completions: { create: async () => fakeStream() } } };
    (p as any).modelConfig = modelCfg();
    const got: any[] = [];
    await p.processStreamingRequest(req({ metadata: { requestId: 'sr', priority: 'normal' } }), (c: any) => got.push(c));
    expect(got.map((c) => c.content)).toEqual(['he', '', 'y']); // 内置流式每 chunk 必回调（空 content 亦然）
    expect(got[2].finishReason).toBe('length');
    expect(String(got[0].id)).toContain('stream-'); // 无 id → stream- 兜底
    expect(got[0].metadata.latency).toBe(0); // requestId 存在 → now-now
  });

  it('内置 OpenAIProvider healthCheck：无 client unhealthy / 有 client 无 config healthy unknown / list 抛错（config 有无两态）', async () => {
    const adapter = new ModelAdapter();
    const p1 = (adapter as any).createProvider('openai');
    const h1 = await p1.healthCheck();
    expect(h1.status).toBe('unhealthy');
    expect(h1.modelId).toBe('unknown');

    const p2 = (adapter as any).createProvider('openai');
    (p2 as any).client = { models: { list: async () => ({ data: [] }) } };
    (p2 as any).modelConfig = null;
    const h2 = await p2.healthCheck();
    expect(h2.status).toBe('healthy');
    expect(h2.modelId).toBe('unknown');

    const p3 = (adapter as any).createProvider('openai');
    (p3 as any).client = { models: { list: async () => { throw new Error('list fail'); } } };
    (p3 as any).modelConfig = modelCfg();
    const h3 = await p3.healthCheck();
    expect(h3.status).toBe('unhealthy');
    expect(h3.modelId).toBe('mock-1');

    (p3 as any).modelConfig = null;
    const h4 = await p3.healthCheck();
    expect(h4.modelId).toBe('unknown');
  });

  it('内置 OpenAIProvider formatMessages 全矩阵（system/messages 三角色/tool 跳过/prompt+messages 不追加）', () => {
    const adapter = new ModelAdapter();
    const p = (adapter as any).createProvider('openai');
    const messages = (p as any).formatMessages({
      id: 'f',
      taskType: 'generation',
      prompt: 'ignored',
      systemPrompt: 'sys',
      messages: [
        { role: 'system', content: 's1', timestamp: 0 },
        { role: 'user', content: 'u1', timestamp: 0 },
        { role: 'assistant', content: 'a1', timestamp: 0 },
        { role: 'tool', content: 't1', timestamp: 0 },
      ],
    } as any);
    expect(messages).toHaveLength(4);
    expect(messages[0]).toEqual({ role: 'system', content: 'sys' });
    expect(messages.map((m: any) => m.role)).toEqual(['system', 'system', 'user', 'assistant']);
  });
});

// ==================== Wave B — 独立 Provider 文件（src/OpenAIProvider.ts / src/GoogleProvider.ts） ====================
import { OpenAIProvider as StandaloneOpenAI } from './OpenAIProvider';
import { GoogleProvider as StandaloneGoogle } from './GoogleProvider';

const okJSON = (body: any, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const sseResponse = (lines: string[]) =>
  new Response(
    new ReadableStream({
      start(c) {
        for (const line of lines) c.enqueue(new TextEncoder().encode(line));
        c.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } }
  );

const installFetchSpy = (routes: { match: (url: string) => boolean; respond: () => any }[]) => {
  const spy = jest.spyOn(globalThis, 'fetch');
  (spy as any).mockImplementation(async (input: any) => {
    const url = String(input);
    for (const r of routes) if (r.match(url)) return r.respond();
    return okJSON({}, 404);
  });
  return spy;
};

describe('Wave-14 B1 — 独立 OpenAIProvider：守卫/健康/降级/解析矩阵', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    jest.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  it('未激活状态 processRequest/processStreamingRequest → 抛错（双 guard 分支）', async () => {
    const p = new StandaloneOpenAI();
    await expect(p.processRequest(req())).rejects.toThrow(/not active/);
    await expect(p.processStreamingRequest(req(), () => {})).rejects.toThrow(/not active/);
  });

  it('初始化 → 请求成功（requestCount>0 后 errorRate 三元 true 边）→ healthCheck healthy', async () => {
    installFetchSpy([
      { match: (u) => u.includes('/models'), respond: () => okJSON({ data: [{ id: 'm' }] }) },
      {
        match: (u) => u.includes('chat/completions'),
        respond: () =>
          okJSON({
            id: 'cc1',
            model: 'gpt-4o-mini',
            choices: [{ message: { role: 'assistant', content: 'hi', tool_calls: [{ id: 't9', function: { name: 'f', arguments: '{"k":1}' } }] }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6, prompt_tokens_details: { cached_tokens: 2 } },
          }),
      },
    ]);
    const p = new StandaloneOpenAI();
    await p.initialize(modelCfg({ id: 'oa', credentials: { apiKey: TEST_KEY } }));
    expect(p.status).toBe('active');
    const r = await p.processRequest(req());
    expect(r.content).toBe('hi');
    expect(r.usage.cachedTokens).toBe(2);
    const h = await p.healthCheck(); // requestCount=1 → errorRate 0/1 三元 true 边
    expect(h.status).toBe('healthy');
    expect(h.errorRate).toBe(0);
  });

  it('请求失败（500）→ 重试耗尽抛错 → healthCheck degraded（degraded 三元 true 边 + healthy if false 边）', async () => {
    installFetchSpy([
      { match: (u) => u.includes('/models'), respond: () => okJSON({ data: [] }) },
      { match: (u) => u.includes('chat/completions'), respond: () => okJSON({ error: 'boom' }, 500) },
    ]);
    const p = new StandaloneOpenAI();
    await p.initialize(modelCfg({ id: 'od', credentials: { apiKey: TEST_KEY, maxRetries: 1 } }));
    await expect(p.processRequest(req())).rejects.toThrow(/500/);
    const h = await p.healthCheck();
    expect(h.status).toBe('degraded');
    expect(h.errorRate).toBe(1);
  });

  it('healthCheck：config 缺失 modelId 兜底（healthy/catch 双态）+ /models 500 → unhealthy', async () => {
    installFetchSpy([
      { match: (u) => u.includes('/models'), respond: () => okJSON({ data: [] }) },
    ]);
    const p = new StandaloneOpenAI();
    await p.initialize(modelCfg({ id: 'oc', credentials: { apiKey: TEST_KEY } }));
    (p as any)._config = null;
    const h1 = await p.healthCheck();
    expect(h1.status).toBe('healthy');
    expect(h1.modelId).toBe('openai-provider');

    installFetchSpy([
      { match: (u) => u.includes('/models'), respond: () => okJSON({}, 500) },
    ]);
    const p2 = new StandaloneOpenAI();
    await p2.initialize(modelCfg({ id: 'oc2', credentials: { apiKey: TEST_KEY } }));
    const h2 = await p2.healthCheck(); // config 在 → catch 分支 modelId 走 config.id
    expect(h2.status).toBe('unhealthy');
    expect(h2.modelId).toBe('oc2');
    expect(p2.status).toBe('error');
    (p2 as any)._config = null;
    const h3 = await p2.healthCheck(); // config 缺 → catch 分支兜底
    expect(h3.modelId).toBe('openai-provider');
  });

  it('流式：!ok 抛错 / body 不可读抛错 / [DONE]·空 content·坏 JSON·正常 chunk 全覆盖', async () => {
    installFetchSpy([
      { match: (u) => u.includes('/models'), respond: () => okJSON({ data: [] }) },
      { match: (u) => u.includes('chat/completions'), respond: () => okJSON({}, 500) },
    ]);
    const p = new StandaloneOpenAI();
    await p.initialize(modelCfg({ id: 'os', credentials: { apiKey: TEST_KEY } }));
    await expect(p.processStreamingRequest(req(), () => {})).rejects.toThrow(/500/);

    installFetchSpy([
      { match: (u) => u.includes('/models'), respond: () => okJSON({ data: [] }) },
      { match: (u) => u.includes('chat/completions'), respond: () => ({ ok: true, status: 200, body: null }) },
    ]);
    await expect(p.processStreamingRequest(req(), () => {})).rejects.toThrow(/not readable/);

    installFetchSpy([
      { match: (u) => u.includes('/models'), respond: () => okJSON({ data: [] }) },
      {
        match: (u) => u.includes('chat/completions'),
        respond: () =>
          sseResponse([
            'data: {"id":"s1","choices":[{"delta":{"content":"he"}}]}\n',
            'data: [DONE]\n',
            ': keep-alive\n',
            'data: {"id":"s2","choices":[{"delta":{}}]}\n', // 空 content → 不回调
            'data: not-json\n', // 解析失败 → logger.error 分支
            'data: {"id":"s3","choices":[{"delta":{"content":"y"},"finish_reason":null}]}\n',
          ]),
      },
    ]);
    const got: any[] = [];
    await p.processStreamingRequest(req(), (c) => got.push(c));
    expect(got.map((c) => c.content)).toEqual(['he', 'y']);
    expect(got[1].finishReason).toBe('stop');
  });

  it('_buildRequestBody 白盒：config 缺失模型兜底 / ContentBlock 三态 / toolChoice function·auto / tools / stopSequences', () => {
    const p = new StandaloneOpenAI();
    (p as any)._config = null;
    const b1 = (p as any)._buildRequestBody(req({ prompt: 'p' }), false);
    expect(b1.model).toBe('gpt-4-turbo-preview'); // || 兜底
    expect(b1.messages).toEqual([{ role: 'user', content: 'p' }]);

    (p as any)._config = modelCfg({ model: 'mm' });
    const b2 = (p as any)._buildRequestBody(
      req({
        systemPrompt: 'sys',
        messages: [
          { role: 'user', content: [{ type: 'text', content: 't1' }, { type: 'image', content: 'IMG' }, { type: 'audio', content: 'a1' }] as any[] },
        ],
        tools: [{ id: 't', type: 'function', function: { name: 'fn', arguments: '{"a":1}' } }],
        toolChoice: { type: 'function', function: { name: 'fn' } },
        stopSequences: ['\\n\\n'],
      }),
      false
    );
    expect(b2.messages[0]).toEqual({ role: 'system', content: 'sys' });
    expect(b2.messages[1].content).toEqual([
      { type: 'text', text: 't1' },
      { type: 'image_url', image_url: { url: 'IMG' } },
      { type: 'text', text: 'a1' },
    ]);
    expect(b2.tools).toHaveLength(1);
    expect(b2.tool_choice).toEqual({ type: 'function', function: { name: 'fn' } });
    expect(b2.stop).toEqual(['\\n\\n']);

    const b3 = (p as any)._buildRequestBody(req({ prompt: 'p', toolChoice: { type: 'auto' } }), true);
    expect(b3.tool_choice).toBe('auto');
    expect(b3.stream).toBe(true);
  });

  it('_parseContent/_parseUsage 白盒：数组三字段兜底 / 对象 String / usage 缺省与 pricing 成本', () => {
    const p = new StandaloneOpenAI();
    (p as any)._config = modelCfg({ pricing: { inputTokensPer1K: 0.02, outputTokensPer1K: 0.06, currency: 'USD', unit: 'token' } });

    expect((p as any)._parseContent('str')).toBe('str');
    const arr = (p as any)._parseContent([
      { type: 'text', text: 't' },
      { image_url: { url: 'u' } },
      { content: 'c' },
      { text: 'x', metadata: { m: 1 } },
    ]);
    expect(arr[0]).toEqual({ type: 'text', content: 't', metadata: undefined });
    expect(arr[1].content).toBe('u');
    expect(arr[2].content).toBe('c');
    expect(arr[3].metadata).toEqual({ m: 1 });
    expect((p as any)._parseContent({ obj: 1 })).toBe(String({ obj: 1 })); // 非数组 → String

    const u1 = (p as any)._parseUsage(undefined); // usage 缺 → 全 0
    expect(u1).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedTokens: 0, cost: 0 });
    const u2 = (p as any)._parseUsage({ prompt_tokens: 8, completion_tokens: 4 }); // total 缺 → input+output
    expect(u2.totalTokens).toBe(12);
    const u3 = (p as any)._parseUsage({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    expect(u3.cost).toBeCloseTo(0.02 * 10 / 1000 + 0.06 * 5 / 1000, 8); // pricing 分支
    expect((p as any)._estimateTokens('abcd')).toBe(1);
  });

  it('validateConfig 三字段全组合 + organization/additionalHeaders 注入', async () => {
    installFetchSpy([{ match: (u) => u.includes('/models'), respond: () => okJSON({ data: [] }) }]);
    const p = new StandaloneOpenAI();
    const vc = (p as any).validateConfig.bind(p);
    expect(vc(modelCfg())).toBe(true); // 全真
    expect(vc({ credentials: {}, model: 'm', id: 'i' })).toBe(false);
    expect(vc({ credentials: { apiKey: TEST_KEY }, model: '', id: 'i' })).toBe(false);
    expect(vc({ credentials: { apiKey: TEST_KEY }, model: 'm', id: '' })).toBe(false);

    await p.initialize(modelCfg({ id: 'oh', credentials: { apiKey: TEST_KEY, organization: 'org-9', additionalHeaders: { 'X-Custom': '1' } } }));
    const headers = (p as any)._getHeaders();
    expect(headers['OpenAI-Organization']).toBe('org-9');
    expect(headers['X-Custom']).toBe('1');
    expect(headers.Authorization).toBe(`Bearer ${TEST_KEY}`);
  });
});

describe('Wave-14 B2 — 独立 GoogleProvider：守卫/解析/流式/安全评级矩阵', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    jest.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  const googleOK = (overrides: Record<string, any> = {}) =>
    okJSON({
      candidates: [
        {
          content: { parts: [{ text: 'g' }] },
          finishReason: 'STOP',
          safetyRatings: [
            { category: 'HARM_A', probability: 'HIGH', blocked: true },
            { category: 'HARM_B', probability: 'MEDIUM' },
            { probability: 'LOW' },
            { category: 'HARM_C', probability: 'OTHER', blocked: false },
          ],
          ...overrides.candidate,
        },
      ],
      usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 4, totalTokenCount: 12 },
      ...overrides.body,
    });

  it('未激活状态 processRequest/processStreamingRequest → 抛错', async () => {
    const p = new StandaloneGoogle();
    await expect(p.processRequest(req())).rejects.toThrow(/not active/);
    await expect(p.processStreamingRequest(req(), () => {})).rejects.toThrow(/not active/);
  });

  it('processRequest 成功链：safetyRatings 解析 / pricing 成本 / STOP 映射 / candidate 无 text → id 兜底空串', async () => {
    installFetchSpy([
      { match: (u) => u.includes('/models?'), respond: () => okJSON({ models: [] }) },
      { match: (u) => u.includes(':generateContent'), respond: () => googleOK() },
    ]);
    const p = new StandaloneGoogle();
    await p.initialize(modelCfg({ id: 'gg', provider: 'google', credentials: { apiKey: TEST_KEY }, pricing: { inputTokensPer1K: 0.01, outputTokensPer1K: 0.02, currency: 'USD', unit: 'token' } }));
    expect(p.status).toBe('active');
    const r = await p.processRequest(req());
    expect(r.id).toBe('g');
    expect(r.content).toEqual([{ type: 'text', content: 'g', metadata: undefined }]);
    expect(r.finishReason).toBe('stop');
    expect(r.usage.cost).toBeCloseTo(0.01 * 8 / 1000 + 0.02 * 4 / 1000, 8);
    const sr = r.metadata.safetyRatings;
    expect(sr[0].severity).toBe('high');
    expect(sr[0].blocked).toBe(true);
    expect(sr[1].severity).toBe('medium');
    expect(sr[2].severity).toBe('low');
    expect(sr[3].severity).toBe('low'); // OTHER → 兜底 low
    expect(sr[2].category).toBe(''); // category 缺 → 空串
    expect(sr[3].blocked).toBe(false);

    installFetchSpy([
      { match: (u) => u.includes('/models?'), respond: () => okJSON({ models: [] }) },
      { match: (u) => u.includes(':generateContent'), respond: () => okJSON({ candidates: [{}] }) },
    ]);
    const r2 = await p.processRequest(req());
    expect(r2.id).toBe(''); // text 缺 → id 兜底
    expect(r2.content).toBe(''); // _parseContent(!content) → ''
  });

  it('generateContent 500（maxRetries 1）→ 抛错 → healthCheck degraded（errorRate/healthy-if 双分支）', async () => {
    installFetchSpy([
      { match: (u) => u.includes('/models?'), respond: () => okJSON({ models: [] }) },
      { match: (u) => u.includes(':generateContent'), respond: () => okJSON({ error: 'g500' }, 500) },
    ]);
    const p = new StandaloneGoogle();
    await p.initialize(modelCfg({ id: 'gd', provider: 'google', credentials: { apiKey: TEST_KEY, maxRetries: 1 } }));
    await expect(p.processRequest(req())).rejects.toThrow(/500/);
    const h = await p.healthCheck();
    expect(h.status).toBe('degraded');
    expect(h.errorRate).toBe(1);
  });

  it('healthCheck：config 缺失双态兜底（healthy/catch）+ /models 500 → unhealthy', async () => {
    installFetchSpy([{ match: (u) => u.includes('/models?'), respond: () => okJSON({ models: [] }) }]);
    const p = new StandaloneGoogle();
    await p.initialize(modelCfg({ id: 'gh', provider: 'google', credentials: { apiKey: TEST_KEY } }));
    (p as any)._config = null;
    const h1 = await p.healthCheck();
    expect(h1.modelId).toBe('google-provider');

    installFetchSpy([{ match: (u) => u.includes('/models?'), respond: () => okJSON({}, 500) }]);
    const p2 = new StandaloneGoogle();
    await p2.initialize(modelCfg({ id: 'gh2', provider: 'google', credentials: { apiKey: TEST_KEY } }));
    const h2 = await p2.healthCheck();
    expect(h2.status).toBe('unhealthy');
    expect(h2.modelId).toBe('gh2');
    (p2 as any)._config = null;
    expect((await p2.healthCheck()).modelId).toBe('google-provider');
  });

  it('流式：!ok / body 不可读 / 非 JSON 行 / 空 content 跳过 / MAX_TOKENS 映射', async () => {
    installFetchSpy([
      { match: (u) => u.includes('/models?'), respond: () => okJSON({ models: [] }) },
      { match: (u) => u.includes(':streamGenerateContent'), respond: () => okJSON({}, 500) },
    ]);
    const p = new StandaloneGoogle();
    await p.initialize(modelCfg({ id: 'gs', provider: 'google', credentials: { apiKey: TEST_KEY } }));
    await expect(p.processStreamingRequest(req(), () => {})).rejects.toThrow(/500/);

    installFetchSpy([
      { match: (u) => u.includes('/models?'), respond: () => okJSON({ models: [] }) },
      { match: (u) => u.includes(':streamGenerateContent'), respond: () => ({ ok: true, status: 200, body: null }) },
    ]);
    await expect(p.processStreamingRequest(req(), () => {})).rejects.toThrow(/not readable/);

    installFetchSpy([
      { match: (u) => u.includes('/models?'), respond: () => okJSON({ models: [] }) },
      {
        match: (u) => u.includes(':streamGenerateContent'),
        respond: () =>
          sseResponse([
            '{"candidates":[{"content":{"parts":[{"text":"g1"}]}}]}\n',
            '{}\n', // 无 content → 跳过
            '{broken json\n', // 解析失败 → catch
            '{"candidates":[{"content":{"parts":[{"text":"g2"}]},"finishReason":"MAX_TOKENS"}]}\n',
          ]),
      },
    ]);
    const got: any[] = [];
    await p.processStreamingRequest(req(), (c) => got.push(c));
    expect(got.map((c) => c.content)).toEqual(['g1', 'g2']);
    expect(got[1].finishReason).toBe('length');
  });

  it('_buildRequestBody 白盒：systemPrompt 双轮注入 / assistant→model 角色 / tools / stopSequences', () => {
    const p = new StandaloneGoogle();
    (p as any)._config = modelCfg({ provider: 'google', model: 'gem' });
    const b = (p as any)._buildRequestBody(req({
      systemPrompt: 'sys',
      messages: [
        { role: 'user', content: 'u1', timestamp: 0 },
        { role: 'assistant', content: 'a1', timestamp: 0 },
      ],
      tools: [{ id: 't', type: 'function', function: { name: 'fn', arguments: '{"a":1}' } }],
      stopSequences: ['END'],
    }) as any);
    expect(b.contents[0]).toEqual({ role: 'user', parts: [{ text: 'sys' }] });
    expect(b.contents[1].role).toBe('model');
    expect(b.contents[2].role).toBe('user');
    expect(b.contents[3].role).toBe('model'); // assistant → model 映射
    expect(b.tools[0].functionDeclarations[0].name).toBe('fn');
    expect(b.generationConfig.stopSequences).toEqual(['END']);

    const b2 = (p as any)._buildRequestBody(req({ prompt: 'only' }) as any);
    expect(b2.contents).toEqual([{ role: 'user', parts: [{ text: 'only' }] }]);
    expect(b2.generationConfig.topK).toBe(40);
  });

  it('_formatContent/_parseContent 白盒：string / 三态 block / parts 三态 / 无 parts String 化', () => {
    const p = new StandaloneGoogle();
    expect((p as any)._formatContent('plain')).toEqual([{ text: 'plain' }]);
    expect((p as any)._formatContent([
      { type: 'text', content: 't' },
      { type: 'image', content: 'B64' },
      { type: 'audio', content: 'a' },
    ] as any[])).toEqual([
      { text: 't' },
      { inlineData: { mimeType: 'image/jpeg', data: 'B64' } },
      { text: 'a' },
    ]);

    expect((p as any)._parseContent(null)).toBe('');
    const parts = (p as any)._parseContent({ parts: [{ text: 't1' }, { inlineData: { data: 'd1' } }, { weird: 1 }] });
    expect(parts[0]).toEqual({ type: 'text', content: 't1', metadata: undefined });
    expect(parts[1]).toEqual({ type: 'image', content: 'd1', metadata: undefined });
    expect(parts[2].type).toBe('text');
    expect(JSON.parse(parts[2].content)).toEqual({ weird: 1 });
    expect((p as any)._parseContent({ noParts: true })).toBe(String({ noParts: true }));
  });

  it('_parseSafetyRatings 白盒：null / 非数组真值 / 全概率映射 / blocked 兜底', () => {
    const p = new StandaloneGoogle();
    expect((p as any)._parseSafetyRatings(null)).toEqual([]);
    expect((p as any)._parseSafetyRatings('not-array' as any)).toEqual([]);
    const out = (p as any)._parseSafetyRatings([
      { category: 'C1', probability: 'HIGH', blocked: true },
      { probability: 'MEDIUM' },
      { category: 'C3', probability: 'LOW', blocked: false },
      { probability: 'SOMETHING' },
    ]);
    expect(out).toHaveLength(4);
    expect(out.map((o: any) => o.severity)).toEqual(['high', 'medium', 'low', 'low']);
    expect(out[0].blocked).toBe(true);
    expect(out[3].blocked).toBe(false);
    expect(out[3].category).toBe('');
  });

  it('validateConfig 组合 + initialize baseURL/timeout/maxRetries 覆盖 + _estimateTokens', async () => {
    installFetchSpy([{ match: (u) => u.includes('/models?'), respond: () => okJSON({ models: [] }) }]);
    const p = new StandaloneGoogle();
    const vc = (p as any).validateConfig.bind(p);
    expect(vc(modelCfg({ provider: 'google' }))).toBe(true);
    expect(vc({ credentials: {}, model: 'm', id: 'i' })).toBe(false);
    expect(vc({ credentials: { apiKey: TEST_KEY }, model: '', id: 'i' })).toBe(false);
    expect(vc({ credentials: { apiKey: TEST_KEY }, model: 'm', id: '' })).toBe(false);

    await p.initialize(modelCfg({
      provider: 'google',
      credentials: { apiKey: TEST_KEY, baseURL: 'https://proxy.local/v1', timeout: 1234, maxRetries: 2 },
    }));
    expect((p as any)._baseURL).toBe('https://proxy.local/v1');
    expect((p as any)._timeout).toBe(1234);
    expect((p as any)._maxRetries).toBe(2);
    expect((p as any)._estimateTokens('abcd')).toBe(1);
    await p.cleanup();
    expect(p.status).toBe('inactive');
  });
});
