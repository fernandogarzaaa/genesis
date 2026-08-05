// ─── Genesis Kernel: OpenAI Provider ─────────────────────────────────
// Implements TextGenerationProvider behind capability 'infra.text_generation'

import OpenAI from 'openai';
import type {
  TextGenerationProvider,
  TextGenerationRequest,
  TextGenerationResponse,
} from '../core/kernel-types.js';

export interface OpenAIConfig {
  apiKey: string;
  defaultModel?: string;
  baseURL?: string;
}

export class OpenAIProvider implements TextGenerationProvider {
  readonly providerId = 'openai-provider';
  readonly providerName = 'OpenAI';
  readonly supportedModels: string[];
  private _client: OpenAI;
  private _defaultModel: string;
  private _config: OpenAIConfig;

  constructor(config: OpenAIConfig) {
    this._config = config;
    this._defaultModel = config.defaultModel ?? 'gpt-4o';
    this.supportedModels = [
      'gpt-4o',
      'gpt-4o-mini',
      'gpt-4-turbo',
      'gpt-4',
      'gpt-3.5-turbo',
      'o1',
      'o1-mini',
      'o3-mini',
    ];
    this._client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    });
  }

  async generate(request: TextGenerationRequest): Promise<TextGenerationResponse> {
    const model = request.model || this._defaultModel;
    const startTime = Date.now();

    try {
      const response = await this._client.chat.completions.create({
        model,
        messages: request.messages.map(m => ({
          role: m.role,
          content: m.content,
        })),
        max_tokens: request.maxTokens,
        temperature: request.temperature,
        top_p: request.topP,
        stop: request.stopSequences,
      });

      const latencyMs = Date.now() - startTime;
      const choice = response.choices[0];
      const content = choice?.message?.content ?? '';

      const tokensUsed = {
        input: response.usage?.prompt_tokens ?? 0,
        output: response.usage?.completion_tokens ?? 0,
        total: response.usage?.total_tokens ?? 0,
      };

      // Cost estimation (approximate per 1M tokens)
      const costPerM = this._costPerMillion(model);
      const cost = (tokensUsed.total / 1_000_000) * costPerM;

      return {
        content,
        model,
        tokensUsed,
        finishReason: this._mapFinishReason(choice?.finish_reason ?? 'stop'),
        latencyMs,
        cost,
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      throw new Error(`OpenAI generation failed: ${err.message}`);
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      // List models as a lightweight health check
      await this._client.models.list({ limit: 1 });
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
      'infra.summarization',
      'infra.translation',
      'infra.classification',
    ];
  }

  private _costPerMillion(model: string): number {
    // Approximate costs as of 2025. Adjust as needed.
    const costs: Record<string, number> = {
      'gpt-4o': 5.00,
      'gpt-4o-mini': 0.30,
      'gpt-4-turbo': 15.00,
      'gpt-4': 30.00,
      'gpt-3.5-turbo': 1.50,
      'o1': 15.00,
      'o1-mini': 3.00,
      'o3-mini': 1.10,
    };
    return costs[model] ?? 5.00;
  }

  private _mapFinishReason(
    reason: string,
  ): TextGenerationResponse['finishReason'] {
    switch (reason) {
      case 'stop':
        return 'stop';
      case 'length':
        return 'length';
      case 'content_filter':
        return 'content_filter';
      default:
        return 'error';
    }
  }
}
