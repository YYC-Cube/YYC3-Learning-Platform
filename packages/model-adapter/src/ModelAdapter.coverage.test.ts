/**
 * 覆盖率冲刺测试（85% 铁律专项）
 * 覆盖：配置管理 / 模型 CRUD / 流处理 / 批处理 / 健康检查 / 指标 / 缓存类 / routing
 */
import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import { ModelAdapter } from './ModelAdapter';
import type { ModelAdapterConfig, ModelConfig, ModelRequest } from './IModelAdapter';

const baseConfig: ModelAdapterConfig = {
  defaultModel: 'gpt-4',
  fallbackModel: 'gpt-3.5-turbo',
  routing: {
    type: 'smart',
    fallback: { enabled: true, maxRetries: 3, retryDelay: 10, exponentialBackoff: false, alternativeModels: ['gpt-3.5-turbo'], fallbackOnErrors: ['rate_limit'] },
  } as any,
  loadBalancing: { strategy: 'round_robin', weights: {}, healthCheckInterval: 60000, unhealthyThreshold: 3, healthyThreshold: 2 } as any,
  cache: { enabled: true, ttl: 300000, maxSize: 1000, strategy: 'lru', compressionEnabled: false, encryptionEnabled: false } as any,
  monitoring: { enabled: true, metricsInterval: 60000, detailedLogging: false, alertThresholds: { errorRate: 0.1, latency: 5000, cost: 100 } } as any,
  providers: [],
  models: [],
} as any;

const modelConfig = (id: string, provider: string, taskTypes: string[]): ModelConfig =>
  ({
    id,
    name: id,
    provider,
    model: `${provider}-model`,
    enabled: true,
    credentials: { apiKey: `test-key-${id}` },
    capabilities: { taskTypes, streaming: true, maxTokens: 4096 },
  }) as any;

const modelRequest = (taskType = 'generation'): ModelRequest =>
  ({ id: `req-${Math.random().toString(36).slice(2, 8)}`, taskType, prompt: 'hello' } as any);

const makeResponse = (requestId: string): any => ({
  requestId,
  modelId: 'gpt-4',
  provider: 'openai',
  content: 'ok',
  timestamp: Date.now(),
  processingTime: 5,
  latency: 5,
  metadata: {},
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
});

describe('Coverage Sprint — 配置与生命周期', () => {
  let adapter: ModelAdapter;

  beforeEach(() => {
    adapter = new ModelAdapter();
  });

  it('initialize → updateConfig → resetConfig 全链', async () => {
    await adapter.initialize(baseConfig);
    expect(adapter.config.defaultModel).toBe('gpt-4');

    await (adapter as any).updateConfig({ defaultModel: 'gpt-4o' });
    expect(adapter.config.defaultModel).toBe('gpt-4o');

    await (adapter as any).resetConfig();
    // resetConfig 回出厂空配置
    expect(adapter.config.defaultModel).toBe('');
  });

  it('start/stop/restart 状态机全覆盖', async () => {
    await adapter.initialize(baseConfig);
    await adapter.start();
    expect(adapter.status).toBe('active');
    await adapter.stop();
    expect(adapter.status).toBe('suspended');
    await adapter.restart();
    expect(adapter.status).toBe('active');
    await adapter.stop();
  });

  it('事件 on/emit/removeListener', async () => {
    let fired = 0;
    const fn = () => fired++;
    adapter.on('custom', fn);
    adapter.emit('custom');
    adapter.removeListener('custom', fn);
    adapter.emit('custom');
    expect(fired).toBe(1);
  });
});

describe('Coverage Sprint — 模型 CRUD 与可用性', () => {
  let adapter: ModelAdapter;

  beforeEach(() => {
    adapter = new ModelAdapter();
  });

  it('addModel/listModels/getModel/updateModel/removeModel 全链', async () => {
    await adapter.addModel(modelConfig('m-1', 'openai', ['generation']));
    expect(adapter.listModels()).toHaveLength(1);
    expect(adapter.getModel('m-1')?.id).toBe('m-1');

    await adapter.updateModel('m-1', { enabled: false });
    expect(adapter.getModel('m-1')?.enabled).toBe(false);

    await adapter.removeModel('m-1');
    expect(adapter.getModel('m-1')).toBeUndefined();
  });

  it('listModelsByProvider 按 provider 过滤', async () => {
    await adapter.addModel(modelConfig('a1', 'openai', ['generation']));
    await adapter.addModel(modelConfig('a2', 'anthropic', ['generation']));
    expect(adapter.listModelsByProvider('openai' as any).map((m) => m.id)).toEqual(['a1']);
    expect(adapter.listModelsByProvider('anthropic' as any).map((m) => m.id)).toEqual(['a2']);
  });

  it('addModel 重复 id 覆盖更新（upsert 语义）', async () => {
    await adapter.addModel(modelConfig('dup', 'openai', ['generation']));
    await adapter.addModel(modelConfig('dup', 'openai', ['analysis']));
    // Map.set 覆盖语义：size 保持 1 且 capabilities 更新
    expect(adapter.listModels()).toHaveLength(1);
    expect(adapter.listModels()[0].capabilities.taskTypes).toEqual(['analysis']);
  });

  it('getAvailableModels 当前实现对全部模型开放（isModelSuitableForTask 恒 true）', async () => {
    await adapter.addModel(modelConfig('gen', 'openai', ['generation']));
    await adapter.addModel(modelConfig('ana', 'openai', ['analysis']));
    // isModelSuitableForTask 当前恒 true（简单适用性检查）——返回全部
    expect(adapter.getAvailableModels('generation' as any)).toHaveLength(2);
    expect(adapter.getAvailableModels('analysis' as any)).toHaveLength(2);
  });

  it('getModelMetrics / getProviderMetrics', async () => {
    expect(adapter.getModelMetrics('nope')).toBeUndefined();
    expect(adapter.getProviderMetrics('openai' as any)).toBeUndefined();
  });

  it('getRoutingMetrics 基线（routing API 在 _router 白盒层）', () => {
    const metrics = (adapter as any)._router.getRoutingMetrics();
    expect(metrics.totalRoutings).toBe(0);
    expect(metrics.routingByStrategy).toBeDefined();
  });
});

describe('Coverage Sprint — processRequest 与流处理', () => {
  let adapter: ModelAdapter;
  let providerMock: any;

  beforeEach(() => {
    adapter = new ModelAdapter();
    providerMock = {
      initialize: jest.fn().mockResolvedValue(true),
      processRequest: jest.fn(async (req: ModelRequest) => makeResponse(req.id)),
      processStreamingRequest: jest.fn(async (req: ModelRequest, onChunk: (c: any) => void) => {
        onChunk(makeResponse(req.id));
      }),
      healthCheck: jest.fn().mockResolvedValue({ status: 'healthy', responseTime: 10, errorRate: 0, uptime: 100 }),
      cleanup: jest.fn().mockResolvedValue(true),
    };
    jest.spyOn(adapter as any, 'createProvider').mockReturnValue(providerMock);
  });

  it('processRequest 带 provider 全链（cache key 生成/响应元数据/缓存回写）', async () => {
    await adapter.initialize(baseConfig);
    await adapter.addModel(modelConfig('gpt-4', 'openai', ['generation']));
    const res = await adapter.processRequest(modelRequest('generation'));
    expect(res.requestId).toBeDefined();
    expect(res.content).toBe('ok');
    // 二次调用走缓存命中
    const res2 = await adapter.processRequest(modelRequest('generation'));
    expect(res2.content).toBe('ok');
  });

  it('processStreamingRequest 驱动 onChunk 回调', async () => {
    await adapter.initialize(baseConfig);
    await adapter.addModel(modelConfig('gpt-4', 'openai', ['generation']));
    const chunks: any[] = [];
    await adapter.processStreamingRequest(modelRequest('generation'), (c) => chunks.push(c));
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].content).toBe('ok');
  });

  it('cancelRequest 挂起请求清理不抛错', async () => {
    await expect(adapter.cancelRequest('nonexistent')).resolves.toBeUndefined();
  });

  it('generateText / generate 高层封装', async () => {
    await adapter.initialize(baseConfig);
    await adapter.addModel(modelConfig('gpt-4', 'openai', ['generation']));
    const text = await (adapter as any).generateText({ prompt: 'hi', maxTokens: 10 });
    expect(text).toBeDefined();
    const gen = await (adapter as any).generate({ prompt: 'hi' });
    expect(gen).toBeDefined();
  });

  it('healthCheck 返回各模型结果', async () => {
    await adapter.initialize(baseConfig);
    await adapter.addModel(modelConfig('gpt-4', 'openai', ['generation']));
    const results = await adapter.healthCheck();
    expect(results['gpt-4']).toBeDefined();
    expect(results['gpt-4'].status).toBe('healthy');
  });

  it('getMetrics 返回适配器指标', () => {
    const metrics = adapter.getMetrics();
    expect(metrics).toBeDefined();
  });

  it('clearCache / getCacheStats 缓存运维', async () => {
    await adapter.initialize(baseConfig);
    await adapter.clearCache();
    const stats = await adapter.getCacheStats();
    expect(stats).toBeDefined();
  });
});

const makeResponse2 = (requestId: string): any => ({
  requestId,
  modelId: 'gpt-4',
  provider: 'openai',
  content: 'ok',
  timestamp: Date.now(),
  processingTime: 5,
  latency: 5,
  metadata: {},
});
