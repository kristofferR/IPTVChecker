/** Plural variants, selected with `Intl.PluralRules` from the `count` param. */
export type PluralForms = {
  readonly zero?: string;
  readonly one?: string;
  readonly two?: string;
  readonly few?: string;
  readonly many?: string;
  readonly other: string;
};

export type Message = string | PluralForms;

/** A namespace must not use `other` as a key, or it reads as a plural. */
export type Catalog = { readonly [key: string]: Message | Catalog };

/** Dotted paths to every message in a catalog. */
export type MessageKeys<T, Prefix extends string = ""> = {
  [K in keyof T & string]: T[K] extends Message
    ? `${Prefix}${K}`
    : MessageKeys<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

export type MessageAt<T, Path extends string> = Path extends `${infer Head}.${infer Rest}`
  ? Head extends keyof T
    ? MessageAt<T[Head], Rest>
    : never
  : Path extends keyof T
    ? T[Path]
    : never;

type Placeholders<S> = S extends `${string}{${infer Name}}${infer Rest}`
  ? Name | Placeholders<Rest>
  : never;

type ParamNames<M> = M extends string
  ? Placeholders<M>
  : M extends PluralForms
    ? "count" | Placeholders<M[keyof M]>
    : never;

export type MessageParams<M, Value> = {
  [Name in ParamNames<M>]: Name extends "count" ? (M extends PluralForms ? number : Value) : Value;
};

/** No params argument for messages without placeholders. */
export type ParamArgs<M, Value> = [ParamNames<M>] extends [never]
  ? []
  : [params: MessageParams<M, Value>];

/** Translations may omit messages; missing ones fall back to English. */
export type Translation<T> = {
  readonly [K in keyof T]?: T[K] extends string
    ? string
    : T[K] extends PluralForms
      ? PluralForms
      : Translation<T[K]>;
};
