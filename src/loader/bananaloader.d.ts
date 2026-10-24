// BananaLoader API typings for Banans. Pair with the game.d.ts exported from Settings → TypeScript.
// Put both in a "types" folder next to your Banans together with the exported jsconfig.json.

/** Every proxied managed object has these. */
interface Il2CppObject {
  /** Address of the object in the wasm heap. */
  readonly $ptr: number;
  /** Full runtime type name, e.g. "UnityEngine.Camera". */
  readonly $type: string;
  /** False once a UnityEngine.Object has been destroyed. */
  readonly $alive: boolean;
  $is(typeName: string): boolean;
  /** Component on the same GameObject. */
  $component<K extends keyof Il2CppTypeMap>(typeName: K): Il2CppTypeMap[K][0] | null;
  $component(typeName: string): any;
  /** Elements of arrays, List<T>, Dictionary<K,V>, … */
  $toArray(): any[] | null;
  $get(name: string): any;
  $set(name: string, value: any): void;
  $call(name: string, ...args: any[]): any;
  /** A method of this object as a patch target / descriptor. */
  $method(name: string, sig?: number | string[]): Il2CppMethodDesc;
  readonly $static: any;
  toString(): string;
}

/** The static side of a type, from Il2Cpp.type(name). */
interface Il2CppTypeProxy<TInstance = any> {
  readonly $name: string;
  readonly $td: number;
  /** System.Type object. */
  readonly $type: Il2CppObject;
  $new(...args: any[]): TInstance;
  $find(): TInstance | null;
  $findAll(limit?: number): TInstance[];
  $method(name: string, sig?: number | string[]): Il2CppMethodDesc;
}

interface Il2CppArray<T> extends Iterable<T> {
  readonly $ptr: number;
  readonly length: number;
  [index: number]: T;
  toArray(): T[];
  $toArray(): T[];
}

/** ref / out parameter box: Il2Cpp.ref(initial) */
interface Il2CppRef<T> { value: T; }

interface Il2CppMethodDesc {
  readonly name: string;
  readonly label: string;
  readonly isStatic: boolean;
  readonly parameterCount: number;
}

/** Filled in by the generated game.d.ts. Maps full type names to [instance, static]. */
interface Il2CppTypeMap {}

interface Il2CppApi {
  /** Static side of a type. Generic types: 'System.Collections.Generic.List<System.Int32>'. */
  type<K extends keyof Il2CppTypeMap>(name: K): Il2CppTypeMap[K][1];
  type(name: string): any;
  /** First live object of a type. */
  find<K extends keyof Il2CppTypeMap>(name: K): Il2CppTypeMap[K][0] | null;
  find(name: string): any;
  findAll<K extends keyof Il2CppTypeMap>(name: K, limit?: number): Il2CppTypeMap[K][0][];
  findAll(name: string, limit?: number): any[];
  /** GameObject by exact name, or the first whose name matches a RegExp. */
  gameObject(name: string | RegExp): Il2Cpp.Types.UnityEngine.GameObject | null;
  gameObjects(name: string | RegExp): Il2Cpp.Types.UnityEngine.GameObject[];
  /** new T(...args) */
  'new'<K extends keyof Il2CppTypeMap>(name: K, ...args: any[]): Il2CppTypeMap[K][0];
  'new'(name: string, ...args: any[]): any;
  wrap(ptr: number): any;
  ptr(x: any): number;
  ref<T>(initial: T): Il2CppRef<T>;
  /** Managed string from a JS string, or the other way round. */
  string(x: string | Il2CppObject): any;
  /** System.Type object for a type name. */
  typeOf(name: string): Il2CppObject;
  isProxy(x: any): boolean;
  method(spec: string, sig?: number | string[]): Il2CppMethodDesc;
  /** The raw bridge (see src/il2cpp/runtime.js). */
  readonly il: any;
  /** Scene helpers (see src/il2cpp/unity.js). */
  readonly unity: any;
}

declare namespace Il2Cpp {
  namespace Types {
    namespace UnityEngine {
      // replaced by the generated definitions when game.d.ts is present
      interface GameObject extends Il2CppObject {}
    }
  }
}

declare const Il2Cpp: Il2CppApi;

// ---------------------------------------------------------------- Banans

interface BananInfo {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly author: string;
  readonly description: string;
  readonly type: 'mod' | 'plugin';
  readonly games: string[];
  readonly color: string;
}

interface BananLogger {
  msg(...args: any[]): void;
  log(...args: any[]): void;
  warning(...args: any[]): void;
  warn(...args: any[]): void;
  error(...args: any[]): void;
  success(...args: any[]): void;
  debug(...args: any[]): void;
  big(...args: any[]): void;
}

interface BananPrefOptions {
  description?: string;
  min?: number;
  max?: number;
  step?: number;
  /** Dropdown choices for string entries. */
  options?: string[];
  kind?: 'bool' | 'number' | 'string' | 'key' | 'color';
  hidden?: boolean;
}

interface BananPref<T> {
  readonly id: string;
  readonly name: string;
  readonly default: T;
  value: T;
  set(value: T, silent?: boolean): void;
  reset(): void;
  /** Returns an unsubscribe function. */
  onChange(fn: (value: T, old: T) => void): () => void;
}

interface BananPrefCategory {
  readonly id: string;
  readonly name: string;
  createEntry<T>(id: string, def: T, name?: string, o?: BananPrefOptions): BananPref<T>;
  getEntry(id: string): BananPref<any> | undefined;
  get(id: string): any;
  set(id: string, value: any): void;
}

interface BananHookContext {
  /** `this` as a proxy (null for static methods). */
  readonly instance: any;
  /** Raw `this` pointer. */
  readonly self: number;
  readonly name: string;
  readonly argCount: number;
  /** Raw wasm arguments. */
  args: any[];
  arg(i: number): any;
  setArg(i: number, value: any): void;
  paramName(i: number): string;
  /** Return value. Setting it in a prefix also skips the original. */
  result: any;
  setResult(value: any): void;
  skipOriginal: boolean;
  callOriginal(): any;
}

interface BananPatchHooks {
  /** Return false (or set ctx.result) to skip the original. */
  prefix?(ctx: BananHookContext): boolean | void;
  postfix?(ctx: BananHookContext): void;
  /** Overload: parameter count or parameter type names ("System.Single", "UnityEngine.Vector3", "*"). */
  sig?: number | string[];
  priority?: number;
}

interface BananPatch {
  readonly target: string;
  readonly calls: number;
  readonly errors: number;
  /** "all": direct calls too · "pending": after a reload · "indirect": indirect calls only */
  readonly coverage: 'all' | 'pending' | 'indirect';
  unpatch(): void;
}

interface BananGui {
  readonly ctx: CanvasRenderingContext2D;
  readonly width: number;
  readonly height: number;
  text(str: any, x: number, y: number, o?: { color?: string; size?: number; weight?: number; font?: string; align?: CanvasTextAlign; baseline?: CanvasTextBaseline; shadow?: boolean }): void;
  box(x: number, y: number, w: number, h: number, o?: { fill?: string | false; stroke?: string; lineWidth?: number; radius?: number }): void;
  line(x1: number, y1: number, x2: number, y2: number, o?: { color?: string; width?: number }): void;
  /** World position -> page pixels through a Camera (null when behind it). */
  worldToScreen(camera: any, pos: { x: number; y: number; z: number }): { x: number; y: number } | null;
}

/** An Odium UI tab (see Odium UI's README for every create* control). */
interface OdiumContainer {
  createSection(text: string): any;
  createButton(text: string, action: () => any, o?: any): any;
  createToggle(text: string, action: (v: boolean) => void, initial?: boolean, o?: any): any;
  createSlider(text: string, action: (v: number) => void, o?: { min?: number; max?: number; step?: number; value?: number; suffix?: string }): any;
  createNumberInput(text: string, action: (v: number) => void, o?: any): any;
  createTextInput(text: string, action: (v: string) => void, o?: any): any;
  createDropdown(options: string[], action: (v: string) => void, o?: any): any;
  createKeybind(text: string, action: (v: string) => void, o?: any): any;
  createColorPicker(text: string, action: (v: string) => void, o?: any): any;
  createStat(text: string, value: string, o?: any): any;
  createLabel(text: string): any;
  createLog(title: string, o?: any): any;
  createGroup(title: string, o?: any): OdiumContainer;
  createColumns(n: number): OdiumContainer[];
  [k: string]: any;
}

declare class Banan {
  readonly info: BananInfo;
  readonly logger: BananLogger;
  readonly loader: any;
  readonly il: any;
  readonly unity: any;
  readonly Il2Cpp: Il2CppApi;
  /** Set this to expose an API to Banans that `@require` you. */
  api?: any;

  onPreInitialize(): void;
  onApplicationStarted(): void;
  onInitializeBanan(): void;
  onLateInitializeBanan(): void;
  onSceneWasLoaded(buildIndex: number, sceneName: string): void;
  onSceneWasInitialized(buildIndex: number, sceneName: string): void;
  onSceneWasUnloaded(buildIndex: number, sceneName: string): void;
  onUpdate(): void;
  onFixedUpdate(): void;
  onLateUpdate(): void;
  onGUI(gui: BananGui): void;
  onPreferencesSaved(): void;
  onPreferencesLoaded(): void;
  onDeinitializeBanan(): void;
  onApplicationQuit(): void;

  readonly prefs: BananPrefCategory;
  pref<T>(id: string, def: T, name?: string, o?: BananPrefOptions): BananPref<T>;
  patch(target: string | Il2CppMethodDesc, hooks: BananPatchHooks): BananPatch;
  unpatchAll(): void;
  startCoroutine(gen: (() => Generator<any, any, any>) | Generator<any, any, any>): object;
  stopCoroutine(c: object): void;
  createTab(name: string, o?: { icon?: string }): OdiumContainer;
  onKey(spec: string, fn: () => void): () => void;
  notify(text: string, type?: 'info' | 'success' | 'warn' | 'error'): void;
  setInterval(fn: () => void, ms: number): number;
  setTimeout(fn: () => void, ms: number): number;
  /** API of a Banan declared with `// @require Name`. */
  require(name: string): any;
  /** API of a Banan declared with `// @optional Name`, or null. */
  optional(name: string): any;
}

declare class BananPlugin extends Banan {}

declare const logger: BananLogger;
declare function Ref<T>(value: T): Il2CppRef<T>;

declare const BananaLoader: {
  readonly version: string;
  readonly game: { company: string; product: string; version: string; unity: string };
  readonly stage: 'boot' | 'pre' | 'started' | 'initialized' | 'late';
  readonly scenes: { handle: number; name: string; buildIndex: number }[];
  readonly banans: { id: string; name: string; version: string; state: string; instance: Banan | null }[];
  readonly Il2Cpp: Il2CppApi;
  readonly il: any;
  readonly unity: any;
  /** The shared Unity Bootstrap: what the page loaded and how the tools attached. */
  readonly bootstrap: {
    readonly state: { loader: { kind: string; label: string; era: string } | null; config: Record<string, any>; wasm: any; runtime: any; unsupported: string | null };
    readonly facts: Map<string, string>;
    /** Plain-text report: phases, build files, wasm, each tool's steps, environment, log. */
    report(): string;
    /** Record something for the loading screen and the report. */
    fact(key: string, value: string): void;
    /** Show the loading screen again. */
    readonly ui: { reopen(): void };
  };
  /**
   * The IntelliSense engine behind the console and editor (static: nothing is called).
   * BananaLoader.complete('Camera.main.tr') → { from, to, items: [{ label: 'transform', kind: 'prop', detail: 'Transform { get; }' }] }
   */
  complete(text: string, caret?: number, ctx?: { roots?: Record<string, any>; bare?: boolean }): {
    from: number; to: number; prefix: string;
    items: { label: string; kind: string; detail?: string; insert?: string }[];
    hint?: { sigs: { ret: string; text: string; params: string[] }[]; active: number };
  } | null;
  /** The loader window, once built. */
  readonly app: any;
  find(name: string): Banan | null;
  enable(name: string): Promise<void>;
  disable(name: string): Promise<void>;
  reload(name: string): boolean;
  Preferences: {
    createCategory(id: string, name?: string): BananPrefCategory;
    getCategory(id: string): BananPrefCategory | undefined;
    save(): void;
    load(): void;
  };
  logger(name: string, color?: string): BananLogger;
  patch(target: string, hooks: BananPatchHooks): BananPatch;
  install(source: string, o?: { origin?: string; url?: string; file?: string }): Promise<any>;
  installFromUrl(url: string): Promise<any>;
  /** Odium Dumper output from the running game (dump.cs, named wasm, script.json, …). */
  dump(o?: { named?: boolean; metadata?: boolean }): Promise<{ files: { name: string; data: Uint8Array | string }[]; summary: Record<string, number>; wasm: boolean }>;
  /** Delete an installed Banan (not folder Banans). */
  uninstall(name: string): Promise<void>;
  on(event: 'banans' | 'stage' | 'scenes' | 'patches' | 'frame' | 'unload', fn: (...a: any[]) => void): void;
};

declare const module: { exports: any };
