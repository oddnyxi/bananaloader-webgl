<div align="center">

<img src="docs/images/icon.png" alt="BananaLoader logo" width="112">

# BananaLoader

**MelonLoader for Unity WebGL games, in JavaScript. Mods are called Banans: drop in a `.js` file and it hooks into the game's lifecycle, patches IL2CPP methods Harmony-style and reads and writes game objects like C#.**

![Unity](https://img.shields.io/badge/Unity-2018.1%20%E2%86%92%206000-e11d2e)
![IL2CPP](https://img.shields.io/badge/IL2CPP-v24%20%E2%86%92%20v31-8250df)
![Mods](https://img.shields.io/badge/mods-JavaScript-f5c518)
![Dependencies](https://img.shields.io/badge/dependencies-0-2ea043)
![License](https://img.shields.io/badge/license-MIT%20%2B%20attribution-lightgrey)
[![Discord](https://img.shields.io/badge/Discord-join-5865F2?logo=discord&logoColor=white)](https://discord.gg/bananaloader)

<img src="docs/images/banans.png" alt="BananaLoader with five Banans installed" width="780">

</div>

## Table of Contents

- [What it is](#what-it-is)
- [Install](#install)
- [Bootstrap](#bootstrap)
- [Your first Banan](#your-first-banan)
- [MelonLoader → BananaLoader](#melonloader--bananaloader)
- [The Banan header](#the-banan-header)
- [Lifecycle](#lifecycle)
- [Il2Cpp interop](#il2cpp-interop)
- [IntelliSense](#intellisense)
- [Generics](#generics)
- [Patching (Harmony)](#patching-harmony)
- [Dependencies](#dependencies)
- [TypeScript](#typescript)
- [Preferences](#preferences)
- [Logging](#logging)
- [Coroutines](#coroutines)
- [UI, keys and onGUI](#ui-keys-and-ongui)
- [Installing Banans](#installing-banans)
- [The window](#the-window)
- [Example Banans](#example-banans)
- [How it works](#how-it-works)
- [Compatibility](#compatibility)
- [Limitations](#limitations)
- [Building](#building)
- [Project structure](#project-structure)
- [Changelog](#changelog)
- [Community](#community)
- [License](#license)

## What it is

[MelonLoader](https://github.com/LavaGang/MelonLoader) loads C# mods into Unity games on desktop. Unity WebGL games run IL2CPP compiled to WebAssembly in a browser tab, so there's nothing for MelonLoader to inject into. BananaLoader is the same idea built for the browser:

- **Banans** are JavaScript mods with MelonLoader's lifecycle: `onInitializeBanan`, `onSceneWasLoaded`, `onUpdate`, `onGUI` and the rest.
- **Il2Cpp interop:** game types and objects behave like JS objects, so `Time.timeScale = 0.5` and `Camera.main.transform.position` work.
- **IntelliSense in the editor and console:** type `Camera.` and `main` is in the list; members, struct fields, enum values, type names and method signatures complete as you type. See [IntelliSense](#intellisense).
- **Harmony-style patches on every method:** prefixes and postfixes on IL2CPP methods, including non-virtual ones that game code calls directly. Prefixes can skip the original or replace the result.
- **Generics:** `List<int>`, `Dictionary<string, Player>`, `GetComponent<T>()`. You can call them, construct them and patch them.
- **Dependencies:** a Banan can `@require` another one (with a version range) and use its API.
- **TypeScript autocomplete:** export a `.d.ts` of the game's types, so `Il2Cpp.find('UnityEngine.Camera').` completes in VS Code.
- **Preferences:** saved settings per Banan, with controls generated in the UI.
- **Hot reload:** edit a Banan in the built-in editor (syntax highlighting, IntelliSense) and press <kbd>Ctrl</kbd>+<kbd>S</kbd>; it unloads (patches, tabs and timers included) and loads again without restarting the game.
- **Built-in Unity Explorer:** browse the scene, inspect objects and call methods, in the same window. Click an object in the game view to select it.
- **Odium UI:** black and red, toggled with <kbd>F8</kbd>.
- **Unity 2018.1 to 6000:** IL2CPP metadata v24.0 to v31, old Emscripten fastcomp builds (Unity 2018 – 2021.1) and LLVM builds (2021.2+), and both the `UnityLoader.js` and `createUnityInstance` loaders.
- **Bootstrap loading screen:** an animated loading screen with every boot phase, download, compile and attach step while the game loads. See [Bootstrap](#bootstrap).

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/).
2. Install `dist/bananaloader.user.js`.
3. Open a Unity WebGL game. BananaLoader appears once the game starts; press <kbd>F8</kbd> to show or hide it.
4. Drop the files from [`examples/`](examples) onto the window to try it out.

The userscript runs at `document-start` on every page but only shows up where a Unity WebGL build is running. To keep it to one site, change `@match`.

## Bootstrap

A bootstrap runs first, at `document-start`, before the game's own scripts. It watches the game load, shows a loading screen while it does, and only then hands over to BananaLoader. If Unity Explorer and BananaLoader are both installed, they share one bootstrap and one loading screen, and each shows up as a tool with its own steps.

| | |
| --- | --- |
| ![Loading screen](docs/images/bootstrap.png) **Loading**: boot phases, live progress, and each tool's steps as they attach | ![Loading screen details](docs/images/bootstrap-details.png) **Details**: every build file, the runtime, the environment and a log |

The loading screen shows:

- **Boot sequence.** Detect the Unity build, download the build files, compile the WebAssembly, start the Unity runtime, attach the tools. Each phase has its timing and what it found (loader API, file count and size, wasm size and compile time, Emscripten toolchain, heap size).
- **Tools.** Every IL2CPP step, timed, with its result: the metadata version and which Unity versions use it, where the registrations are, the calibrated `Il2CppClass` / `MethodInfo` layout, the calling convention, how many engine methods survived stripping, and BananaLoader's own steps (reading installed Banans, loading them, building the interop, running `onInitializeBanan`).
- **Details** (click **Details**):
  - **Build files**: every build file with its kind, size, live progress, encoding, `fetch` or `XHR`, and timing.
  - **Runtime**: product, company, Unity version, loader, toolchain, wasm size and compile mode, memory, function table, import/export counts and the wasm analysis.
  - **Environment**: browser, threads, RAM, cross-origin isolation and BigInt support.
  - **Log**: a timestamped log of everything above.
- **Copy report** puts all of it on the clipboard as text, for bug reports.

When everything is attached, the screen folds into a small pill in the corner and fades out, and the tool's window appears. You can open the window earlier with its hotkey. If something fails, the screen turns into a corner card that says what went wrong, so it never covers a game that is running. The dimmed backdrop never blocks clicks. Under **Settings → Loading screen** you can switch to a corner card or turn the screen off. **Show loading screen** brings it back.

The bootstrap only observes, and it runs on every page, so it follows three rules:

1. **Every call goes through unchanged.** The page gets its own promises and `Response` objects. Download progress and the wasm bytes are read from clones, so URLs, caching and the browser's compiled-code cache behave as they normally would.
2. **Nothing beyond pass-through until there's proof of Unity.** That means a call to a Unity loader, or an Emscripten `Module` that belongs to Unity. Other wasm libraries on the page (Draco, Basis, physics engines) are told apart from the game.
3. **The bootstrap's own bookkeeping can never throw into the page.**

On pages without Unity, the one global hook (`Object.prototype.asm`) is removed a few seconds after the page loads, and nothing is shown.

| It hooks | To learn |
| --- | --- |
| `UnityLoader.instantiate` (Unity 5.6 – 2019.4) and `createUnityInstance` (2020.1+) | which loader, the build config, Unity's own progress, the game instance |
| `fetch` and `XMLHttpRequest`, for build files only | file sizes, encodings, download progress, the `Build/*.json` manifest |
| `WebAssembly.instantiate` / `instantiateStreaming` | compile time, the module's memory and function table, and the wasm bytes (analysed for exact function signatures) |
| `Module.asm` and `Module.postRun` | when the Emscripten runtime has its exports, and when `main()` has run |

## Your first Banan

Press **New** in the Banans tab (or the Editor), or save this as `my-banan.js` and drop it on the window:

```js
// ==Banan==
// @name        Slow Motion
// @version     1.0.0
// @author      You
// @description Press F9 to toggle slow motion.
// ==/Banan==

module.exports = class SlowMotion extends Banan {
  onInitializeBanan() {
    this.Time = Il2Cpp.type('UnityEngine.Time');
    this.speed = this.pref('speed', 0.3, 'Slow-motion speed', { min: 0.05, max: 1, step: 0.05 });
    this.onKey('F9', () => {
      this.on = !this.on;
      this.Time.timeScale = this.on ? this.speed.value : 1;
      this.logger.msg(this.on ? 'Slow motion on' : 'Back to normal');
    });
  }

  onDeinitializeBanan() {
    this.Time.timeScale = 1;
  }
};
```

## MelonLoader → BananaLoader

| MelonLoader | BananaLoader |
| --- | --- |
| `MelonMod` / `MelonPlugin` | `Banan` / `BananPlugin` |
| `[assembly: MelonInfo(...)]` | the `// ==Banan==` header |
| `[assembly: MelonGame("Company", "Game")]` | `// @game Game Name` (wildcards allowed) |
| `Mods/` / `Plugins/` folder | installed Banans, or a linked folder on disk |
| `OnInitializeMelon` / `OnLateInitializeMelon` | `onInitializeBanan` / `onLateInitializeBanan` |
| `OnPreInitialization` / `OnApplicationStarted` (plugins) | `onPreInitialize` / `onApplicationStarted` |
| `OnSceneWasLoaded` / `OnSceneWasInitialized` / `OnSceneWasUnloaded` | same names, camelCase: `(buildIndex, sceneName)` |
| `OnUpdate` / `OnFixedUpdate` / `OnLateUpdate` / `OnGUI` | `onUpdate` / `onFixedUpdate` / `onLateUpdate` / `onGUI(gui)` |
| `OnDeinitializeMelon` / `OnApplicationQuit` | `onDeinitializeBanan` / `onApplicationQuit` |
| `OnPreferencesSaved` / `OnPreferencesLoaded` | `onPreferencesSaved` / `onPreferencesLoaded` |
| `MelonLogger.Msg / Warning / Error` | `this.logger.msg / warning / error` |
| `MelonPreferences.CreateCategory / CreateEntry` | `this.pref(...)` or `BananaLoader.Preferences.createCategory(...).createEntry(...)` |
| `HarmonyInstance.Patch(...)`, `[HarmonyPatch]` | `this.patch('Type::Method', { prefix, postfix })` |
| `[MelonAdditionalDependencies]`, `[MelonOptionalDependencies]` | `// @require Name >=1.0.0`, `// @optional Name` |
| `MelonCoroutines.Start(IEnumerator)` | `this.startCoroutine(function* () { ... })` |
| `Il2CppInterop` generated proxies | `Il2Cpp.type(...)`, `Il2Cpp.find(...)`: proxies built at runtime, typed by an exported `game.d.ts` |
| UnityExplorer (a separate mod) | built in: the Scene and Classes tabs |

## The Banan header

```js
// ==Banan==
// @name        Display name
// @version     1.2.0
// @author      You
// @description One line shown in the Banans tab.
// @game        Bullet Force        (repeatable; matches the product name; * = any; wildcards ok)
// @type        mod | plugin         (plugins load first and get onPreInitialize/onApplicationStarted)
// @color       #f5c518              (console colour; picked for you if omitted)
// @require     Other Banan >=1.2.0  (repeatable; loads first; see Dependencies)
// @optional    Another Banan        (repeatable; loads first if it's installed)
// @homepage    https://…
// ==/Banan==
```

The code sets `module.exports` to a class extending `Banan` (or `BananPlugin`), or to a plain object of callbacks. These are in scope: `Banan`, `BananPlugin`, `BananaLoader`, `Il2Cpp`, `logger` and `Ref`.

## Lifecycle

Every callback is optional. They run in this order:

| Callback | When |
| --- | --- |
| `onPreInitialize()` | The game's wasm has loaded but no game code has run yet. Use it to hook the page or the Emscripten `Module` (`this.loader.Module`). |
| `onApplicationStarted()` | Plugins only: IL2CPP is up, before mods initialize. |
| `onInitializeBanan()` | IL2CPP and the engine are ready. Patch, read types and create preferences and tabs here. |
| `onLateInitializeBanan()` | Every Banan has initialized and the first frame has run. |
| `onSceneWasLoaded(buildIndex, name)` | A scene finished loading. This hooks `SceneManager.sceneLoaded`, so it also fires for additive loads. |
| `onSceneWasInitialized(buildIndex, name)` | One frame later, after the scene's `Awake` and `Start`. |
| `onSceneWasUnloaded(buildIndex, name)` | A scene was unloaded. |
| `onUpdate()` / `onLateUpdate()` | Every frame, right after Unity's frame. They run through the Emscripten main loop, so the timing is exact. |
| `onFixedUpdate()` | At `Time.fixedDeltaTime` steps of scaled time. |
| `onGUI(gui)` | Every frame, to draw on the overlay. |
| `onPreferencesSaved()` / `onPreferencesLoaded()` | After preferences are written to or read from storage. |
| `onDeinitializeBanan()` | The Banan is being disabled, reloaded or deleted. |
| `onApplicationQuit()` | The page is closing. |

A Banan enabled or installed while the game is running catches up: it gets every callback it would have had, including `onSceneWasLoaded` for the scenes that are already open. A callback that keeps throwing is switched off after 25 errors; the first few are logged.

## Il2Cpp interop

`Il2Cpp` turns game types and objects into JavaScript proxies, built from the game's metadata at runtime. Type names can be written directly, as in C#:

```js
Time.timeScale = 0.5;                                 // UnityEngine.Time
Camera.main.transform.position;                       // { x, y, z }
UnityEngine.SceneManagement.SceneManager.sceneCount;  // full names and namespaces work too
```

A bare name means the matching type, preferring `UnityEngine`, then the game's assemblies (`Assembly-CSharp`), then `System`. In Banans, names the browser already defines keep their browser meaning, so existing code that uses `Image`, `Event` or `Screen` is unaffected; use the full name (`UnityEngine.Screen.width`) or `Il2Cpp.type('UnityEngine.Screen')` for those. In the console, the Unity type wins over browser globals other than the JavaScript built-ins. Your own variables and the Banan scope always win.

The explicit form works everywhere and takes generic names:

```js
const Time = Il2Cpp.type('UnityEngine.Time');
Time.timeScale = 0.5;                                // static property setter
Time.deltaTime;                                       // static property getter

const cam = Il2Cpp.find('UnityEngine.Camera');        // first live object of a type
cam.transform.position = { x: 0, y: 20, z: -10 };     // structs are plain objects
cam.WorldToScreenPoint({ x: 0, y: 0, z: 0 });         // methods; the overload is picked by your arguments

const player = Il2Cpp.find('PlayerController');       // game types work the same way
player.health = 100;                                  // fields (auto-property backing fields too)
player.Respawn();
player.$component('UnityEngine.Rigidbody').velocity;  // GetComponent on the same GameObject

Il2Cpp.gameObject('Main Camera');                     // GameObject by name
Il2Cpp.gameObjects(/Enemy/);                          // every GameObject matching a RegExp
Il2Cpp.findAll('EnemyAI');                            // every live instance
Il2Cpp.new('UnityEngine.GameObject', 'Spawned');      // constructors
Il2Cpp.type('PlayerController').Instance;             // static fields

const out = Il2Cpp.ref(0);                            // ref / out parameters
Il2Cpp.type('System.Int32').TryParse('42', out);      // true, out.value === 42
```

| On a proxy | |
| --- | --- |
| `$ptr` | the object's address |
| `$type` | its full type name |
| `$is('Type')` | an `is` check |
| `$static` | the type's static side |
| `$component('Type')` | a component on the same GameObject |
| `$toArray()` | the elements of a `List<T>`, `Dictionary` or array |
| `$get(name)` / `$set(name, v)` / `$call(name, ...args)` | explicit member access, for names that clash with JS |

Arrays are proxies too: index into them, read `length`, or use `for…of`.

Values convert like this: strings ↔ JS strings, numbers, booleans, `long` ↔ BigInt, enums ↔ numbers, structs ↔ plain objects, and objects ↔ proxies (`null` for null). The raw bridge is still there as `Il2Cpp.il`, along with the scene helpers as `Il2Cpp.unity`.

## IntelliSense

The editor and the console prompt complete as you type:

![IntelliSense: completing members of Transform](docs/images/intellisense.png)

| You type | You get |
| --- | --- |
| `Camera.` | static members: `main`, `allCameras`, `GetAllCameras(…)`, nested types |
| `Camera.main.transform.` | `Transform` members, inherited ones included |
| `Camera.main.transform.position.` | struct fields `x`, `y`, `z` |
| `KeyCode.` | enum values with their numbers |
| `UnityEngine.` | namespaces and types |
| `Il2Cpp.type('Cam` / `$component('` / `.of('` | full type names |
| `Il2Cpp.method('UnityEngine.Time::` | members of that type, accessors included (for patches) |
| `transform.Rotate(5, ` | every overload, the current parameter underlined |
| `const cam = Camera.main;` … `cam.` | locals, `for (const x of …)` and `this.x = …` are followed |
| `this.` | Banan members (`logger`, `pref`, `createTab`, …) and fields you assigned |

Types follow through fields, property getters and method results, with generic arguments filled in (`List<Enemy>.Find(…)` returns `Enemy`). <kbd>Tab</kbd> or <kbd>Enter</kbd> accepts, <kbd>↑</kbd>/<kbd>↓</kbd> choose, <kbd>Esc</kbd> closes, <kbd>Ctrl</kbd>+<kbd>Space</kbd> opens the list anywhere.

It's static: completion reads the metadata and never calls a getter or a method while you type. It lists what the build contains, so members Unity stripped from the build (a game that never uses `Camera.main` has no `get_main`) aren't offered.

The same engine is available as `BananaLoader.complete('Camera.main.tr')` for external tools. For VS Code, export a `.d.ts` instead (see [TypeScript](#typescript)).

## Generics

Generic types are named the way C# writes them. Type arguments are full names, or C# keywords such as `int` and `string`:

```js
const List = Il2Cpp.type('System.Collections.Generic.List<int>');
const list = List.$new();
list.Add(1); list.Add(2);
list.Count;                                   // 2
list.get_Item(0);                             // 1
for (const x of list.$toArray()) { ... }

const scores = Il2Cpp.new('System.Collections.Generic.Dictionary<string, int>');
scores.set_Item('nyxi', 9001);
const out = Il2Cpp.ref(0);
scores.TryGetValue('nyxi', out);              // true, out.value === 9001
```

Generic methods take their type arguments through `.of(...)`:

```js
const go = Il2Cpp.gameObject('Main Camera');
go.GetComponent.of('UnityEngine.Camera')();  // GetComponent<Camera>()
```

Type arguments can be generic or arrays themselves: `Dictionary<string, List<int>>`, `List<string[]>`. As with C#, only instantiations the game was built with exist (see [Limitations](#limitations)).

## Patching (Harmony)

```js
this.patch('UnityEngine.UI.Button::OnPointerClick', {
  prefix(ctx) {
    this.logger.msg(`Clicked ${ctx.instance.gameObject.name}`);
    return true;                 // return false to skip the original method
  },
});

this.patch('Weapon::GetDamage', {
  sig: 0,                        // pick an overload: parameter count or ['System.Single', ...]
  postfix(ctx) {
    ctx.result = ctx.result * 2; // change the return value
  },
});
```

| `ctx` | |
| --- | --- |
| `instance` | `this` as a proxy (`self` is the raw pointer) |
| `arg(i)` / `setArg(i, v)` | read or replace an argument, as JS values |
| `args` | the raw wasm arguments |
| `result` | read or set the return value. Setting it in a prefix also skips the original |
| `skipOriginal` | set to `true` to skip the original |
| `callOriginal()` | run the original yourself |
| `method`, `name`, `argCount`, `paramName(i)` | about the patched method |

Patches belong to the Banan that made them and are removed when it unloads. `this.patch()` returns a handle with `.unpatch()`. Several Banans can patch the same method; `priority` sets the order. The **Patches** tab lists every active patch with its call and error counts.

Generic targets work too. Each instantiation is patched separately, even where IL2CPP shares one compiled body between them:

```js
this.patch('System.Collections.Generic.List<int>::Add', { prefix(ctx) { ctx.setArg(0, 42); } });
this.patch('UnityEngine.GameObject::GetComponent<UnityEngine.Rigidbody>', { postfix(ctx) { ... } });
this.patch(Il2Cpp.method('PlayerController::TakeDamage', ['System.Single']), { ... });   // a descriptor
```

**Every call is caught, including direct ones.** IL2CPP compiles most non-virtual calls as direct `call` instructions in the wasm, which never pass through the function table. When a Banan patches one of those methods, BananaLoader rewrites the game's wasm on the next load, so each direct call to it goes through the table instead. The **Patches** tab shows a patch's coverage:

| Coverage | Means |
| --- | --- |
| **all** | every caller is hooked |
| **pending** | indirect calls are hooked now, direct calls after a page reload. The tab offers a **Reload now** button. |
| **indirect** | direct-call patching is off (Settings), or the build couldn't be rewritten |

The rewrite only touches call sites of patched methods, takes about a second even for a 100 MB build, and is cached per build. Turning **Direct-call patching** off in Settings, or turning on Safe mode, loads the original wasm untouched.

## Dependencies

```js
// ==Banan==
// @name     Scene Report
// @require  Scene Tools >=1.0.0
// @optional FPS Overlay
// ==/Banan==

module.exports = class extends Banan {
  onInitializeBanan() {
    const tools = this.require('Scene Tools');   // its `api`, or the instance if it has none
    const fps = this.optional('FPS Overlay');    // null when it isn't installed
  }
};
```

A library Banan sets `this.api = { ... }` in `onInitializeBanan`. The rules:

- **Load order.** Required and optional Banans load first. Cycles and missing or disabled requirements show up as a clear error on the Banan's card.
- **Versions.** Ranges use `>=`, `>`, `<=`, `<`, `=`, `^` and `~`. Space-separated ranges must all match.
- **Unloading.** Unloading, reloading or updating a library unloads its dependents first and loads them again afterwards.
- **Late dependencies.** A Banan waiting on a missing library loads as soon as the library is installed or enabled.

The Banans tab shows each Banan's requirements as chips. See [`scene-tools-lib.js`](examples/scene-tools-lib.js) and [`scene-report.js`](examples/scene-report.js).

## TypeScript

**Settings → TypeScript** exports three files:

- **`game.d.ts`:** every type in the game's assemblies, generated from its metadata. Pick which assemblies to include, and whether to keep only public members.
- **`bananaloader.d.ts`:** the BananaLoader API.
- **`jsconfig.json`**

Put them next to your Banans and VS Code completes and type-checks plain JavaScript:

```js
const cam = Il2Cpp.find('UnityEngine.Camera');   // typed as UnityEngine.Camera
cam.fieldOfView = 90;                             // number
cam.transform.position.x;                         // Vector3 fields
Il2Cpp.type('UnityEngine.Time').timeScale;        // statics
```

Game types live under `Il2Cpp.Types.<namespace>`, e.g. `Il2Cpp.Types.UnityEngine.Camera`, for JSDoc annotations. `Il2CppTypeMap` maps full names to `[instance, static]`. The same export is available from code: `BananaLoader.generateTypes({ assemblies, publicOnly })`.

## Preferences

```js
const fov = this.pref('fov', 90, 'Field of view', { min: 60, max: 120, step: 1, description: 'Camera FOV' });
fov.value;                               // read
fov.value = 100;                         // write: saved automatically, the UI updates
fov.onChange((v, old) => apply(v));

this.pref('mode', 'Fast', 'Mode', { options: ['Fast', 'Pretty'] });   // dropdown
this.pref('key', 'F5', 'Hotkey', { kind: 'key' });                     // key picker
this.pref('tint', '#e11d2e', 'Tint', { kind: 'color' });               // colour picker
```

The control type depends on the default value and options: a toggle for booleans, a slider for numbers with `min` and `max` (a number box otherwise), a dropdown when there are `options`, and a text box for other strings. Values are stored in `localStorage` per category and entry, and they survive reloads and reinstalls.

## Logging

`this.logger.msg / warning / error / success / debug / big` write to the BananaLoader console in the Banan's colour, and to the browser console. `BananaLoader.logger('Name', '#hex')` gives you a logger of your own.

## Coroutines

```js
this.startCoroutine(function* () {
  this.logger.msg('waiting 3 seconds');
  yield 3;                       // seconds
  yield;                         // one frame
  yield { frames: 10 };          // ten frames
  const r = yield fetch(url);    // until a promise settles; resumes with its value
});
```

Coroutines run once per game frame and stop when their Banan unloads.

## UI, keys and onGUI

```js
const tab = this.createTab('My Banan');          // an Odium UI tab under "Banans"
tab.createToggle('God mode', (on) => { ... });
tab.createSlider('Speed', (v) => { ... }, { min: 0, max: 10 });

this.onKey('F6', () => { ... });                 // hotkey, also while the game has focus
this.notify('Saved!', 'success');                // toast

onGUI(gui) {                                     // overlay canvas, redrawn every frame
  gui.box(10, 10, 160, 40);
  gui.text('Hello', 20, 20, { color: '#f5c518', size: 16 });
  gui.line(x1, y1, x2, y2, { color: '#e11d2e' });
  const p = gui.worldToScreen(Il2Cpp.find('UnityEngine.Camera'), enemy.transform.position);
  gui.ctx;                                       // the raw CanvasRenderingContext2D
}
```

Tabs, hotkeys, timers (`this.setInterval`, `this.setTimeout`), patches and coroutines are all cleaned up when a Banan unloads.

## Installing Banans

- **Add file / drag and drop:** `.js` files, stored in the browser (IndexedDB).
- **URL:** downloads a raw `.js` file. Banans installed this way get an **Update** button.
- **New / Editor:** write one in the browser.
- **Folder:** link a folder on your computer (Chromium browsers only), like MelonLoader's `Mods` folder. Edit the files in your own editor, then use **Reload from folder** to hot-reload what changed.
- **Settings → Export all Banans / Import backup** moves your setup between browsers.

Turning on **Safe mode** in Settings starts the game with every Banan disabled, so you can get past a broken one.

## The window

| | |
| --- | --- |
| ![Console](docs/images/console.png) **Console**: every Banan's log, filterable, plus a JS prompt | ![Patches](docs/images/patches.png) **Patches**: live patch list with call counts |
| ![Editor](docs/images/editor.png) **Editor**: write a Banan and hot-reload it with Ctrl+S | ![Preferences](docs/images/prefs.png) **Preferences**: generated from each Banan's entries |

The **Scene** and **Classes** tabs are Unity Explorer, built in: a hierarchy, an inspector with live editing and method calls, and a class browser. From the console prompt, `inspect(obj)` opens any proxy in them.

**Picking objects.** Press the target button in the Scene tab, hover the game and click. It checks, in order, UI elements under the cursor (topmost canvas first), a camera raycast against 3D colliders, then 2D colliders. The hovered object is outlined with its name and type. <kbd>Esc</kbd> or right-click cancels.

## Example Banans

| File | Shows |
| --- | --- |
| [`hello-banan.js`](examples/hello-banan.js) | every lifecycle callback, preferences, a tab and a hotkey |
| [`time-control.js`](examples/time-control.js) | static property interop and preferences with `onChange` (F9 pause, Ctrl+↑/↓) |
| [`fps-overlay.js`](examples/fps-overlay.js) | `onGUI` drawing and a dropdown preference |
| [`button-logger.js`](examples/button-logger.js) | a Harmony-style prefix that can skip the original |
| [`log-mirror.js`](examples/log-mirror.js) | a plugin using `onPreInitialize` to catch the engine's first log lines |
| [`scene-tools-lib.js`](examples/scene-tools-lib.js) | a library Banan exposing an `api` |
| [`scene-report.js`](examples/scene-report.js) | `@require` / `@optional` and using another Banan's API |

## How it works

1. **Attach.** The [bootstrap](#bootstrap) catches the Emscripten `Module` the moment the framework assigns `Module.asm`, before the game's `main` runs. Banans are read from IndexedDB in the meantime, and their `onPreInitialize` runs right there. IL2CPP attaches once `main()` has run (the bootstrap's `Module.postRun` hook).
2. **IL2CPP bridge** (shared with Unity Explorer):
   - `global-metadata.dat` is read straight out of the heap. It holds the name of every type, method, field and property. Its layout (v24.0 to v31) is worked out from record sizes.
   - `Il2CppCodeRegistration` maps each method to its code: through per-assembly code modules (Unity 2019.2+) or one flat `methodPointers` array (Unity 2018).
   - The `Il2CppClass` and `MethodInfo` layouts are worked out by testing them against `System.String`.
   - Methods are called directly with IL2CPP's calling convention. On fastcomp builds (Unity 2018 – 2021.1), every signature has its own sub-table inside the wasm table. The bridge reads their offsets from the build's `dynCall_*` functions, along with fastcomp's struct ABI, the `MethodInfo*` arguments the optimizer dropped, and the dummy `this` static methods took before Unity 2018.3.
3. **Frames.** BananaLoader chains Emscripten's `Module.postMainLoop`, so `onUpdate` and the rest run right after each Unity frame, which is also when it's safe to call into managed code.
4. **Patching.**
   - A tiny wasm module is generated that imports the JS hook and re-exports it with the method's exact wasm signature (the same trick as Emscripten's `addFunction`). The signature comes from the game's own wasm binary, which the bootstrap reads while the game loads. Banans still get the IL-level arguments, even where fastcomp split a `long` in two or dropped the `MethodInfo*`.
   - The method's slot in the function table is swapped for that function. Every indirect call (vtables, `MethodInfo`, delegates, invokers) now lands in the hook, and the original is kept to call through to.
   - Unpatching swaps the original back in.
   - Shared generic code is told apart by the `MethodInfo*` IL2CPP passes as the last argument.
   - **Direct calls.** `WebAssembly.instantiateStreaming` is hooked at `document-start`. When patches need it, the code section is decoded and each `call f` to a patched function becomes `i32.const slot; call_indirect`, which is the same call through the table, so it lands in the hook. Nothing else in the module changes.
5. **Scenes.** BananaLoader patches `SceneManager.Internal_SceneLoaded` and `Internal_SceneUnloaded`, which the engine calls for every load. If a build lacks them, it polls instead.

## Compatibility

BananaLoader shares Unity Explorer's IL2CPP bridge, so it runs on the same Unity versions: **2018.1 through 6000.x** WebGL builds that use WebAssembly. That means metadata v24.0 to v31, Emscripten fastcomp builds (Unity 2018 – 2021.1) and LLVM builds (2021.2+), and both the `UnityLoader.js` and `createUnityInstance` loaders. asm.js builds aren't supported, and the loading screen says so.

Tested end to end in headless Chromium, with both tools, on public WebGL builds from each era. For each build, every method's resolved function was also checked against the build's own wasm: for example, `Math.Sqrt` has to land on a function containing `f64.sqrt`.

| Test build | Unity | Metadata | Toolchain · loader | Checked |
| --- | --- | --- | --- | --- |
| MaskShader | 2018.2.6f1 | v24.0 | fastcomp · `UnityLoader.js` | static `this` detected; string, float, int and `out` calls; generic types |
| apartment | 2018.3.6f1 | v24.1 | fastcomp · `UnityLoader.js` | 502 GameObjects via `FindObjectsOfType`, transforms, components, a BananaLoader patch |
| InterceptExample | 2019.3.0f6 | v24.2 | fastcomp · `UnityLoader.js` | calls, generic types, both tools on one page |
| HealthBarExample | 2020.1.6f1 | v24.2 | fastcomp · `createUnityInstance` | 81 GameObjects (verified heap scan), components |
| unity-webgl-deploy | 2020.3.9f1 | v27 | fastcomp · `createUnityInstance` | attach, calls, generic types |
| SpaceTest | 2021.3.14f1 | v29 | LLVM · `createUnityInstance` | attach, calls, `out` parameters |
| UVMapping | 2023.1.18f1 | v29 | LLVM · `createUnityInstance` | attach, calls, `out` parameters |

The 2018.3 build was also tested with the userscript injected after the game had started. Most of these demos strip whatever engine APIs they don't use, so some scene features depend on what a game kept.

## Limitations

- **Direct calls need one reload.** A new patch on a directly-called method catches every caller only after the page reloads (coverage **pending** until then). Methods IL2CPP inlined into their callers can't be patched at all, as with Harmony.
- **Generic instantiations the game never used.** IL2CPP only compiles the generic instantiations the game needs (plus shared reference-type code). `List<MyStruct>` works only if the game uses it.
- **Stripped code.** Anything the game never used isn't in the build. Accessing a stripped member returns `undefined`, and calling one throws a clear error.
- **Scene names.** If a build strips the scene-name APIs, scenes are reported as `Scene <handle>`.
- **Injected after the game started.** If BananaLoader is injected into a game that's already running, it can't see the wasm compile, so it downloads the wasm again from the cache. On fastcomp builds (Unity 2018 – 2021.1), patching needs the exact signatures it gets from that file, and direct calls can't be rewritten until the page reloads.
- **Banans run in the page with the game's privileges.** Only install Banans you trust, just as you would with DLL mods.

## Building

```bash
bun scripts/build.js             # minified -> dist/bananaloader.user.js and dist/bananaloader.js
bun scripts/build.js --readable  # unminified
```

## Project structure

```
bananaloader/
├── src/
│   ├── main.js              entry: bootstrap, hooks, loader, window
│   ├── hook.js              document-start: direct-call wasm rewrite, key shield
│   ├── bootstrap/           document-start bootstrap and loading screen (shared with Unity Explorer)
│   ├── loader/
│   │   ├── loader.js        Banan lifecycle, scenes, frames, install/reload
│   │   ├── banan.js         Banan / BananPlugin base classes, header parser, compiler
│   │   ├── interop.js       re-export of il2cpp/interop.js
│   │   ├── patcher.js       Harmony-style patching through the function table
│   │   ├── wasmfn.js        JS function -> typed wasm function
│   │   ├── wasmrewrite.js   direct call -> call_indirect rewriting of the game's wasm
│   │   ├── typegen.js       game.d.ts generator
│   │   ├── bananaloader.d.ts API typings
│   │   ├── prefs.js         BananaPreferences
│   │   ├── logger.js        loggers and the console feed
│   │   ├── coroutines.js    generator coroutines
│   │   ├── overlay.js       onGUI canvas
│   │   └── store.js         IndexedDB and linked folder
│   ├── app/                 the window: Banans, Console, Preferences, Patches, Editor (with highlight.js), Settings
│   ├── il2cpp/              IL2CPP bridge, metadata v24.0 – v39, Il2Cpp proxies, IntelliSense engine (shared with Unity Explorer)
│   ├── dumper/              Odium Dumper: dump.cs, named wasm, script.json
│   ├── ui/                  explorer views, the in-game picker and the autocomplete popup (shared with Unity Explorer)
│   └── odium/               Odium UI
├── examples/                example Banans
└── scripts/build.js
```

## Changelog

### 1.4.0

- **Syntax highlighting in the Banan editor.** Keywords, strings, template literals (with nested `${…}`), regexes, numbers, comments, the `// ==Banan==` header and its `@tags`, lifecycle methods, method calls, properties, and game type names (`Camera`, `Vector3`, … coloured when the game has that type). The textarea stays the real editor, so selection, undo, IME and autocomplete work as before.
- <kbd>Tab</kbd> in the editor now keeps the undo history.

### 1.3.1

- **Fix: the userscript failed to load** with `Invalid regular expression: … Range out of order in character class`. The minified build contained a literal U+FFFF character, which some userscript managers mangle when they inject the script. The identifier pattern is now ASCII-only, and the build escapes every non-ASCII character, so the output is plain ASCII.

### 1.3.0

- **IntelliSense** in the Banan editor and the console: type names, namespaces, static and instance members (inherited ones included), struct fields, enum values, type names inside `Il2Cpp.type('…')`, `$component('…')` and `.of('…')`, and signature help with every overload. Locals, `for…of` variables and `this.x = …` assignments are followed. Static only: nothing runs while you type. Also exposed as `BananaLoader.complete(text)`.
- **Bare type names** in Banans and the console: `Camera.main`, `Time.timeScale = 0.5`, `UnityEngine.Time`. In Banans, browser globals (`Image`, `Event`, …) keep their meaning, so existing Banans behave the same. Banans still run in strict mode.
- Struct values use property names for auto-property backing fields (`{ Count }` instead of `{ '<Count>k__BackingField' }`); writes accept either.
- The interop layer moved to `src/il2cpp/interop.js` and is shared with Unity Explorer (whose console now has `Il2Cpp` too). `loader/interop.js` re-exports it.

### 1.2.0

- **Older Unity versions.** Unity 2018.1 – 2021.1 now work, as well as 2021.2+. This adds IL2CPP metadata v24.0 – v27, Emscripten fastcomp builds and the `UnityLoader.js` loader. Patching on those builds uses the exact wasm signature of each function table slot.
- **Bootstrap.** A shared `document-start` bootstrap with an animated loading screen: boot phases, build file downloads, WebAssembly compile, each IL2CPP and BananaLoader step with timings, runtime and environment details, a log, and a copyable report. Settings: **Loading screen** (full screen, corner card, off), **Show loading screen** and **Copy bootstrap report**. `BananaLoader.bootstrap` exposes it to Banans.
- **Fix: Unity 2018 – 2020 froze on attach.** Emscripten's `Module` has a `then()` method on those versions, so resolving a Promise with it looped forever.
- **Fix: with Unity Explorer on the same page,** BananaLoader's direct-call rewriting hook could be skipped. Each tool now keeps its own hooks, and they share the bootstrap.
- **Fix: direct-call rewriting on fastcomp builds,** whose function table segment sits at an imported `tableBase`.
- **Fix: heap-scan fallback could crash the game.** When a build strips every `FindObjectsOfType` variant, GameObjects are found by scanning the heap. Stale memory that only looked like an object could be passed to the engine, which aborted. Each candidate's native object now has to point back at it.
- **Fix: `System.Type` arguments on fastcomp builds.** `RuntimeTypeHandle` and other one-field structs are passed by pointer there. This affected `FindObjectsOfType`, `GetComponents` and `MakeGenericType`.

## Community

Questions, bug reports, Banan showcases and help with modding: join the BananaLoader Discord at **[discord.gg/bananaloader](https://discord.gg/bananaloader)**.

## License

[MIT with attribution](LICENSE.md). © 2025-2026 Nyxi. BananaLoader is inspired by [MelonLoader](https://github.com/LavaGang/MelonLoader) but shares no code with it.