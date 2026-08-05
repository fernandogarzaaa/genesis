// ─── Genesis Kernel: Anthropic Provider ──────────────────────────────
// Implements TextGenerationProvider behind capability 'infra.text_generation'

import Anthropic from '@anthropic-ai/sdk';
import type {
  TextGenerationProvider,
  TextGenerationRequest,
  TextGenerationResponse,
} from '../core/kernel-types.js';

export interface AnthropicConfig {
  apiKey: string;
  defaultModel?: string;
  baseURL?: string;
}

export class AnthropicProvider implements TextGenerationProvider {
  readonly providerId = 'anthropic-provider';
  readonly providerName = 'Anthropic';
  readonly supportedModels: string[];
  private _client: Anthropic;
  private _defaultModel: string;

  constructor(config: AnthropicConfig) {
    this._defaultModel = config.defaultModel ?? 'claude-sonnet-4-20250514';
    this.supportedModels = [
      'claude-sonnet-4-20250514',
      'claude-opus-4-20250514',
      'claude-3-5-sonnet-latest',
      'claude-3-5-haiku-latest',
      'claude-3-opus-latest',
    ];
    this._client = new Anthropic({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    });
  }

  async generate(request: TextGenerationRequest): Promise<TextGenerationResponse> {
    const model = request.model || this._defaultModel;
    const startTime = Date.now();

    try {
      // Extract system message if present
      const systemMsg = request.messages.find(m => m.role === 'system');
      const chatMessages = request.messages
        .filter(m => m.role !== 'system')
        .map(m => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        }));

      const response = await this._client.messages.create({
        model,
        system: systemMsg?.content,
        messages: chatMessages,
        max_tokens: request.maxTokens ?? 4096,
        temperature: request.temperature,
        top_p: request.topP,
        stop_sequences: request.stopSequences,
      });

      const latencyMs = Date.now() - startTime;

      // Extract text content
      const textBlocks = response.content.filter(
        (block): block is { type: 'text'; text: string } =>
          block.type === 'text',
      );
      const content = textBlocks.map(b => b.text).join('\n');

      const tokensUsed = {
        input: response.usage?.input_tokens ?? 0,
        output: response.usage?.output_tokens ?? 0,
        total:
          (response.usage?.input_tokens ?? 0) +
          (response.usage?.output_tokens ?? 0),
      };

      const costPerM = this._costPerMillion(model);
      const cost = (tokensUsed.total / 1_000_000) * costPerM;

      return {
        content,
        model,
        tokensUsed,
        finishReason: this._mapStopReason(response.stop_reason ?? 'end_turn'),
        latencyMs,
        cost,
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      throw new Error(`Anthropic generation failed: ${err.message}`);
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      // Lightweight check — just verify the client is configured
      await this._client.messages.create({
        model: this.supportedModels[this.supportedModels.length - 1],
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      });
      return true;
    } catch {
      return false;
    }
  }

  getCapabilities(): string[] {
    return [
      'infra.text_generation',
      'infra.reasoning',
      'infra.code_generation',
      'infra.analysis',
      'infra.summarization',
    ];
  }

  private _costPerMillion(model: string): number {
    const costs: Record<string, number> = {
      'claude-sonnet-4-20250514': 3.00,
      'claude-opus-4-20250514': 15.00,
      'claude-3-5-sonnet-latest': 3.00,
      'claude-3-5-haiku-latest': 0.80,
      'claude-3-opus-latest': 15.00,
    };
    return costs[model] ?? 3.00;
  }

  private _mapStopReason(
    reason: string,
  ): TextGenerationResponse['finishReason'] {
    switch (reason) {
      case 'end_turn':
        return 'stop';
      case 'max_tokens':
        return 'length';
      case 'stop_sequence':
        return 'stop';
      default:
        return 'error';
    }
  }
}
