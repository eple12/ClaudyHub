# Claudy Web

Play against and analyse with the **Claudy** chess engine and **Stockfish 19**, entirely in the browser.
Both engines are WebAssembly builds that run locally on your device: no server, nothing is uploaded.

**Live:** https://eple12.github.io/ClaudyWeb/

* **Play** – You / Claudy / Stockfish on either side (so engine-vs-engine works too), time controls with
  increment or fixed move time, optional Elo limit (Claudy 100–3400, Stockfish 1320–3190), take-back, resign,
  clocks, promotion picker, drag & click input.
* **Analysis** – both engines can run side by side, MultiPV 1–5, best-move arrows, depth history table with SAN
  principal variations (click a move to play the line), PGN/FEN import and export, full-game review
  (per-move eval, inaccuracy / mistake / blunder marks, accuracy), eval-history chart.
* Same look as [ClaudyBot Live](https://eple12.github.io/ClaudyBot/).

## How it performs

* Claudy: `-O3 -msimd128 -flto`, WASM SIMD (`i32x4.dot_i16x8_s`) NNUE inference, magic bitboards (no PEXT in
  WebAssembly), the same Lazy-SMP search as the native engine on real threads (`SharedArrayBuffer`).
  Identical node counts to the native build (`bench` = 2262552), single-thread speed about 70–80 % of native AVX2.
* Stockfish: [Stockfish.js](https://github.com/nmrugg/stockfish.js) 19, full multi-threaded build (94 MB,
  downloaded the first time it is used; the 1.6 MB lite network is selectable in the settings).
* Threads default to "automatic" (all but one hardware thread, shared when both engines analyse).

The page needs a cross-origin isolated context (COOP/COEP). GitHub Pages cannot send those headers, so
[`coi-serviceworker`](https://github.com/gzuidhof/coi-serviceworker) adds them: the first visit reloads once.
Without isolation (private window with service workers blocked) only Stockfish Lite works.

## Local use

```
python serve.py 8124      # sends the COOP/COEP headers itself
```

then open http://localhost:8124/ .

## Rebuilding the Claudy WebAssembly engine

Needs [emsdk](https://github.com/emscripten-core/emsdk). In the engine repository
([ClaudyEngine](https://github.com/eple12/ClaudyEngine)):

```
tools\build_wasm.ps1 -Emsdk D:\path\to\emsdk -Out web\engine
node web\test\node_test.js "bench 13" "wait:6000"      # nodes must match the native bench
```

## Third-party

| Component | Licence |
|---|---|
| [Stockfish.js](https://github.com/nmrugg/stockfish.js) / [Stockfish](https://github.com/official-stockfish/Stockfish) (`stockfish/`) | GPL-3.0, see `stockfish/COPYING.txt`; source in the linked repositories |
| [chess.js](https://github.com/jhlywa/chess.js) (`vendor/chess.js`) | BSD-2-Clause |
| [coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker) | MIT |
| Caliente pieces by avi (`pieces/`) | CC BY-NC-SA 4.0 |
