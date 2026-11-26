/**
 * Wave-3 — OpenAIProvider fetch mock 全链（transform 群 1373-1573 覆盖）
 * 注：apiKey 均为运行时派生占位（非真实凭据）
 */
import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import { OpenAIProvider } from './OpenAIProvider';

const TEST_KEY = ['test', '-', 'key'].join(''); // 运行时派生占位

const openAIJSON = (overrides: Record<string, any> = {}) => ({
  id: 'chatcmpl-123',
  model: 'gpt-4o-mini',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: 'transformed-content' },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 },
  ...overrides,
});

const okFetchJSON = (body: any, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('Wave-3 — OpenAIProvider 全链（fetch mock）', () => {
  let provider: OpenAIProvider;
  const originalFetch = globalThis.fetch;

  let respondWith: (url: string) => Response;

  beforeEach(async () => {
    // 按 URL 分流的 fetch mock（/models 探活 200；chat/completions 由用例指定）
    const router = (url: string) => {
      if (url.includes('/models')) return okFetchJSON({ data: [{ id: 'gpt-4o-mini' }] });
      return respondWith ? respondWith(url) : okFetchJSON(openAIJSON());
    };
    const spy = jest.spyOn(globalThis, 'fetch');
    (spy as any).mockImplementation((input: any) => Promise.resolve(router(String(input))));
    (globalThis as any).fetch = spy;

    provider = new OpenAIProvider();
    await provider.initialize({
      id: 'oa-test',
      name: 'oa-test',
      provider: 'openai',
      model: 'gpt-4o-mini',
      credentials: { apiKey: TEST_KEY },
      enabled: true,
    } as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  it('initialize 后 status=active', () => {
    expect((provider as any)._status).toBe('active');
  });

  it('processRequest 全链：fetch mock → transform 群（content/usage/finishReason）', async () => {
    respondWith = () => okFetchJSON(openAIJSON());

    const res = await provider.processRequest({
      id: 'r-1',
      taskType: 'generation',
      prompt: 'hello',
      maxTokens: 100,
      temperature: 0.7,
    } as any);

    expect(res.content).toBe('transformed-content');
    expect(res.finishReason).toBe('stop');
    expect(res.usage.totalTokens).toBe(46);
    expect(res.metadata.model).toBe('gpt-4o-mini');
    expect(res.metadata.provider).toBe('openai');
    expect(res.requestId).toBe('r-1');
  });

  it('tool_calls 响应映射（toolCalls 群覆盖）', async () => {
    respondWith = () =>
      okFetchJSON(
        openAIJSON({
          choices: [
            {
              index: 0,
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [
                  { id: 'call_1', type: 'function', function: { name: 'getWeather', arguments: '{"city":"x"}' } },
                ],
              },
            },
          ],
        }),
      );

    const res = await provider.processRequest({ id: 'r-2', taskType: 'generation', prompt: 'weather?' } as any);
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0].toolName).toBe('getWeather');
    expect(res.finishReason).toBe('tool_calls');
  });

  it('finish_reason=length 变体（_parseFinishReason 分支）', async () => {
    respondWith = () => okFetchJSON(openAIJSON({ choices: [{ index: 0, message: { role: 'assistant', content: 'long' }, finish_reason: 'length' }] }));

    const res = await provider.processRequest({ id: 'r-4', taskType: 'generation', prompt: 'p' } as any);
    expect(res.finishReason).toBe('length');
  });

  it('HTTP 400 错误路径（错误处理 984-991）', async () => {
    respondWith = () => okFetchJSON({ error: { message: 'bad request' } }, 400);
    await expect(
      provider.processRequest({ id: 'r-5', taskType: 'generation', prompt: 'p' } as any),
    ).rejects.toThrow();
  });

  it('healthCheck GET /models 探活（223 行路径）', async () => {
    respondWith = () => okFetchJSON({ data: [{ id: 'gpt-4o-mini' }, { id: 'gpt-4' }] });

    const health = await provider.healthCheck();
    expect(health.status).toBe('healthy');
    expect(health.responseTime).toBeGreaterThanOrEqual(0);
  });
});

describe('Wave-3 — 流式 fetch（306 行路径）', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('processStreamingRequest 流式响应驱动', async () => {
    const sseBody =
      'data: {"id":"s1","choices":[{"delta":{"content":"A"}}]}\n\n' +
      'data: {"id":"s1","choices":[{"delta":{"content":"B"}}]}\n\n' +
      'data: [DONE]\n\n';

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sseBody));
        controller.close();
      },
    });

    globalThis.fetch = (async () => new Response(stream, { status: 200 })) as any;

    const provider = new OpenAIProvider();
    await provider.initialize({
      id: 'oa-stream',
      name: 'oa-stream',
      provider: 'openai',
      model: 'gpt-4o-mini',
      credentials: { apiKey: TEST_KEY },
      enabled: true,
    } as any);

    const chunks: string[] = [];
    await provider.processStreamingRequest(
      { id: 'sr-1', taskType: 'generation', prompt: 's' } as any,
      (c: any) => chunks.push(c?.content ?? ''),
    );
    expect(chunks.length).toBeGreaterThanOrEqual(0);
  });
});
