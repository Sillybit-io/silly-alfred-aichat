export type ReasoningInfo = {
  efforts: string[];
  mandatory: boolean;
  defaultEffort: string | null;
  defaultEnabled: boolean;
};

export type ModelRecord = {
  id: string;
  name: string;
  contextLength: number;
  promptPrice: number;
  completionPrice: number;
  // True when any price besides prompt and completion is above zero, such as per-image or per-second prices.
  otherPriced?: boolean;
  inputModalities: string[];
  outputModalities: string[];
  reasoning: ReasoningInfo | null;
  supportedParameters: string[];
};

type Json = { [key: string]: unknown };

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function price(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : 0;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

// Prices that say nothing about what the model itself costs to call.
const IGNORED_PRICES = new Set(["prompt", "completion", "web_search", "internal_reasoning", "input_cache_read", "input_cache_write"]);

// Reads one entry of the models list; entries without an id are dropped.
export function normalizeModel(raw: unknown): ModelRecord | null {
  if (!isObject(raw) || typeof raw.id !== "string" || raw.id === "") return null;
  const architecture = isObject(raw.architecture) ? raw.architecture : {};
  const pricing = isObject(raw.pricing) ? raw.pricing : {};
  const inputModalities = strings(architecture.input_modalities);
  const outputModalities = strings(architecture.output_modalities);
  const reasoning = isObject(raw.reasoning)
    ? {
        efforts: strings(raw.reasoning.supported_efforts),
        mandatory: raw.reasoning.mandatory === true,
        defaultEffort: typeof raw.reasoning.default_effort === "string" ? raw.reasoning.default_effort : null,
        defaultEnabled: raw.reasoning.default_enabled === true,
      }
    : null;
  return {
    id: raw.id,
    name: typeof raw.name === "string" && raw.name !== "" ? raw.name : raw.id,
    contextLength: typeof raw.context_length === "number" ? raw.context_length : 0,
    promptPrice: price(pricing.prompt),
    completionPrice: price(pricing.completion),
    otherPriced: Object.entries(pricing).some(([key, value]) => !IGNORED_PRICES.has(key) && price(value) > 0),
    inputModalities: inputModalities.length > 0 ? inputModalities : ["text"],
    outputModalities: outputModalities.length > 0 ? outputModalities : ["text"],
    reasoning,
    supportedParameters: strings(raw.supported_parameters),
  };
}

export function acceptsImage(model: ModelRecord | null): boolean {
  return model !== null && model.inputModalities.includes("image");
}

export function acceptsFile(model: ModelRecord | null): boolean {
  return model !== null && model.inputModalities.includes("file");
}

export function producesImage(model: ModelRecord | null): boolean {
  return model !== null && model.outputModalities.includes("image");
}

export function supportsReasoning(model: ModelRecord | null): boolean {
  return model !== null && model.reasoning !== null;
}

// Efforts a user may pick; "none" is offered only where reasoning can be turned off.
export function efforts(model: ModelRecord | null): string[] {
  if (!model || !model.reasoning) return [];
  const list = model.reasoning.efforts.filter((effort) => effort !== "none");
  if (!model.reasoning.mandatory && !list.includes("none")) list.push("none");
  return list;
}

export function perMillion(perToken: number): number {
  return Math.round(perToken * 1_000_000 * 1e6) / 1e6;
}

// Only text models and ":free" variants can be called free: image, video, and similar models report a zero
// token price because they are billed per image or per second.
export function isFree(model: ModelRecord): boolean {
  if (model.promptPrice !== 0 || model.completionPrice !== 0 || model.otherPriced === true) return false;
  return model.id.endsWith(":free") || model.outputModalities.every((modality) => modality === "text");
}

// Zero token prices on a model that is not free: the real price is per image, per second, or per use.
export function pricedPerUse(model: ModelRecord): boolean {
  return model.promptPrice === 0 && model.completionPrice === 0 && !isFree(model);
}
