import type { EmbeddingConfig } from "../config.js";

export class EmbeddingClient {
  readonly #config: EmbeddingConfig;

  constructor(config: EmbeddingConfig) {
    this.#config = config;
  }

  isEnabled(): boolean {
    return this.#config !== null;
  }

  async embedTexts(texts: string[]): Promise<number[][]> {
    if (!this.#config) {
      throw new Error("Embeddings are not configured.");
    }

    const response = await fetch(`${this.#config.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.#config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.#config.model,
        input: texts,
      }),
    });

    if (!response.ok) {
      throw new Error(`Embedding request failed (${response.status}): ${await response.text()}`);
    }

    const payload = (await response.json()) as {
      data?: Array<{ embedding?: number[] }>;
    };

    return (payload.data ?? []).map((item) => item.embedding ?? []);
  }
}
