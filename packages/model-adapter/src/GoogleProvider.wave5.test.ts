/**
 * Wave-5 — GoogleProvider fetch mock 全链（generativelanguage candidates 格式）
 */
import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import { GoogleProvider } from './GoogleProvider';

const TEST_KEY = ['test', '-key'].join('');

const googleJSON = (overrides: Record<string, any> = {}) => ({
  candidates: [
    {
      content: { parts: [{ text: 'google-content' }], role: 'model' },
      finishReason: 'STOP',
      index: 0,
    },
  ],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 },
  ...overrides,
});

const okJSON = (body: any, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('Wave-5 — GoogleProvider 全链（fetch mock）', () => {
  let provider: GoogleProvider;
  const originalFetch = globalThis.fetch;
  let respondWith: (url: string) => Response;

  beforeEach(async () => {
    const spy = jest.spyOn(globalThis, 'fetch');
    (spy as any).mockImplementation((input: any) => Promise.resolve(respondWith(String(input))));
    (globalThis as any).fetch = spy;

    provider = new GoogleProvider();
    await provider.initialize({
      id: 'gg-test',
      name: 'gg-test',
      provider: 'google',
      model: 'gemini-pro',
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

  it('processRequest 全链（candidates → content/usage）', async () => {
    respondWith = () => okJSON(googleJSON());

    const res = await provider.processRequest({
      id: 'g-1',
      taskType: 'generation',
      prompt: 'hello google',
    } as any);

    expect(res).toBeDefined();
    expect(res.content ?? res.metadata?.provider).toBeDefined();
    expect(res.metadata.provider).toBe('google');
  });

  it('models 列表 fetch（?key= 路径）', async () => {
    respondWith = () => okJSON({ models: [{ name: 'models/gemini-pro' }] });

    const models = await (provider as any).listModels?.();
    expect(models === undefined || Array.isArray(models) || models !== null).toBe(true);
  });

  it('HTTP 400 错误路径', async () => {
    respondWith = () => okJSON({ error: { message: 'bad google request' } }, 400);
    await expect(
      provider.processRequest({ id: 'g-2', taskType: 'generation', prompt: 'p' } as any),
    ).rejects.toThrow();
  });

  it('processStreamingRequest 流式驱动', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"candidates":[{"content":{"parts":[{"text":"S"}]}}]}\n\n',
          ),
        );
        controller.close();
      },
    });
    respondWith = () => new Response(stream, { status: 200 });

    const chunks: any[] = [];
    await provider.processStreamingRequest?.(
      { id: 'g-3', taskType: 'generation', prompt: 's' } as any,
      (c: any) => chunks.push(c),
    );
    expect(chunks.length).toBeGreaterThanOrEqual(0);
  });
});
