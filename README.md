# Latex Suite Extension

An [Obsidian.md](https://obsidian.md/) plugin that extends [Latex Suite](https://github.com/artisticat1/obsidian-latex-suite) with seven features in one plugin:

1. **Flicker-free inline math**: no more flickering while typing inside $...$.
2. **Tolerant math rendering**: $ x + y $ (spaces inside the dollar signs) and $ $ (empty math) render as math anyway, in both Live Preview and Reading view.
3. **RTL math text**: mix right-to-left text into MathJax expressions with a single short command: \he{שלום}. Command names are configurable in the settings.
4. **Automatic keyboard switching**: the system keyboard follows the cursor: your note language outside math, English inside $...$, and Hebrew/Arabic inside \he{...} / \ar{...}.
5. **Inline math displaystyle**: inline $...$ math renders in \displaystyle (full-size fractions, sums, integrals) without writing it (Toggle it on/off in settings)
6. **Solve**: type `\solve` after an equation chain and the last expression is evaluated and appended.
7. **Built-in snippets**: in math, he → \he{|}, ar → \ar{|}, sol → \solve, with no Latex Suite configuration needed.

## How it works

### Flicker-free inline math

Obsidian doesn't recognize `$[space]...$` or `$...[space]$` as math. While you type inside an inline math, the plugin inserts `{}` right after the opening `$` and right before the closing `$`:

```latex
${} ... {}$
```

so the math never becomes invalid mid-keystroke. The braces are hidden by decorations and treated as single characters by atomic ranges, and they are automatically removed when the cursor leaves the math. (Turn on "Debug mode > Disable decorations" in the settings to see them.)

If the math is empty when you leave it, it is cleaned up to `$ $` - never `$$`, which Obsidian would misread as a display math delimiter - and tolerant rendering (below) keeps displaying it as math.

### Tolerant math rendering

A separate rendering layer picks up the inline math candidates Obsidian refuses: `$ ... $` with whitespace touching either dollar sign (like `$\frac{480}{430}   $`), or with only whitespace inside. They are rendered with Obsidian's own MathJax:

- in **Live Preview** as a widget, and
- in **Reading view** via a markdown post processor.

**Editing tolerant math**: the moment the cursor touches such a candidate (by clicking, arrow keys, wrapping a line in `$...$`, or typing the closing `$`), the plugin converts it in place to the brace-guarded form `${}   ...   {}$` from the flicker-free feature. That form is real math to Obsidian's parser, so native syntax coloring and all Latex Suite features (snippets, tabout) work inside it, while the braces stay hidden. When the cursor leaves, the cleanup normalizes the text to standard valid math - `$   x   $` becomes `$x$` - so edited math self-heals into a form that renders everywhere, even without this plugin. Spaced math you never touch stays as-is and is rendered by the tolerant layer.

One guard against false positives: a one-sided candidate whose content has internal spaces but no math notation (like `$5 and $ 6` in prose) is treated as currency, not math. Code blocks, inline code, comments, tables, and already-valid math are never converted.

### RTL math text

```latex
$\he{שלום, עולם!}$
```

Each configured command (default: `\he` for Hebrew, `\ar` for Arabic) expands to `\class{mjx-rtl}{\text{...}}` - the `\text{}` is built into the macro, so one short command is all you write. Nest math inside via `\(...\)`; Latin words inside RTL text order themselves correctly through the Unicode bidi algorithm, so no dedicated LTR command is needed. The plugin also mirrors MathJax's spacing rules as CSS logical properties so spacing stays correct in RTL runs.

You can also set the fonts used for Hebrew (default: David CLM) and Arabic text inside math in the settings. Both go into one font stack, so each character automatically uses the first font that contains it; the fonts must be available to Obsidian (installed on the system or loaded by a theme/CSS snippet).

Arabic letter joining is handled by the plugin: MathJax 3 renders text one character per element, which breaks Arabic contextual forms ([mathjax/MathJax#3041](https://github.com/mathjax/MathJax/issues/3041)), so the plugin merges those runs back together after rendering.

#### Built-in snippets

The plugin ships its own math-mode snippets - no Latex Suite configuration needed:

| Type | Get |
|---|---|
| `he` | `\he{\|}` (cursor inside, keyboard switches to Hebrew) |
| `ar` | `\ar{\|}` (cursor inside, keyboard switches to Arabic) |
| `sol` | `\solve` (solves immediately) 

The RTL triggers follow the configured command names. They never fire after a letter or backslash (`\theta`, `\varphi`, `\arcsin` are safe), outside math, inside `\text{...}`-style commands, or inside an RTL command's argument. Toggle them off under "Math rendering > Built-in snippets" — for example if you prefer managing the equivalents in Latex Suite's own snippet list (having both is safe: Latex Suite expands first and the built-in trigger then never sees the text).

The plugin also **auto-closes `$`**: typing `$` inserts `$|$` with the cursor in the middle; a second `$` upgrades the empty pair to display math `$$|$$`; typing `$` right before a closing `$` steps over it instead of doubling it; and typing `$` with text selected wraps the selection in `$...$`. Escaped `\$` and `$` inside code/comments are left alone. Toggle under "Math rendering > Auto-close $".

#### Automatic keyboard switching (desktop only)

The plugin keeps the system keyboard matched to where the cursor is, in three layers (innermost wins):

| Cursor position                | Keyboard                                                          |
| ------------------------------ | ----------------------------------------------------------------- |
| inside `\he{...}` / `\ar{...}` | Hebrew / Arabic input source                                      |
| inside `$...$` or `$$...$$`    | math input source (default: ABC/English)                          |
| regular note text              | note input source - the main language of your notes (e.g. Hebrew) |

Each layer's input source is configurable in the settings; leaving one empty means "don't switch in that context". Switching only happens when the cursor **crosses a boundary**, so manually changing the layout mid-context is respected until you enter/leave math. To pause switching entirely (e.g. to write a whole section in English), use the "Toggle keyboard auto-switching" command - bind it to a hotkey for one-keystroke pausing.

This requires the [im-select](https://github.com/daipeihust/im-select) command-line tool, which lives in its author's Homebrew tap:

```bash
brew tap daipeihust/tap
brew trust daipeihust/tap
brew install im-select
```

The `brew trust` step is required on newer Homebrew versions (6+), which refuse to install from third-party taps until they are explicitly trusted - without it, `brew install` fails with "Refusing to load formula ... from untrusted tap". Verify the install by running `im-select`; it should print the ID of the currently active keyboard layout.

The plugin auto-detects the Homebrew install location (a custom path can be set in the settings). To find the ID of a keyboard layout, activate it and run `im-select` in a terminal - the defaults are `com.apple.keylayout.Hebrew` and `com.apple.keylayout.Arabic`. The feature can be turned off in the settings.

### Display style for inline math

Inline math is rendered as if every formula started with `\displaystyle`, so fractions, sums, and integrals appear full-size inside `$...$` no need to type it. This happens at render time only; your notes' text is untouched. Toggle it under "Math rendering" in the settings (re-open notes to re-render math that is already on screen). Formulas that already contain `\displaystyle` are left alone.

### Solve (`\solve`)

Type `\solve` inside math right after an equation, and it is replaced by the numerically evaluated result:

```latex
k_1=\frac{\omega}{v_1} =\frac{200}{40}\solve
→ k_1=\frac{\omega}{v_1} =\frac{200}{40} \quad \to \quad k_1=5
```

Rules:

- Only the expression after the **last top-level `=`** is evaluated, and the left-hand side before the **first `=`** of that step is repeated in the result. Derivation steps separated by `\quad`, `\xrightarrow{...}`, `\Rightarrow`, commas, etc. are respected - only the last step counts, so multi-step lines are safe.
- Supported math: numbers, `+ - \cdot \times /`, `\frac`/`\cfrac`/`\dfrac`, `^`, `\sqrt` (incl. `\sqrt[n]`), parentheses, `\pi`, `e`, and `\sin \cos \tan \arcsin \arccos \arctan \sinh \cosh \tanh \ln \log \exp` (radians). Inverse notation works: `\sin^{-1}(x)` is arcsin, and `\sin^{2}(x)` means `(sin x)^2`. Degrees are understood via `49.2^\circ` (converted to radians). Unicode `× − · ÷ π` from pasted text are understood too.
- Angle results are shown in degrees (`41.1395^\circ`) when **both** hold: the expression is an inverse trig call like `\sin^{-1}\left(\frac{1}{1.52}\right)`, **and** the left-hand side is an angle-named variable — `\theta_{c}=\sin^{-1}(...)` gets degrees, `r_{c}=\sin^{-1}(...)` stays a plain number. The angle names (`theta, vartheta, phi, varphi, alpha, beta, gamma, delta, psi` by default) and the degrees/radians choice are both configurable under Settings → Solve. With no left-hand side at all, inverse trig alone decides. `\approx`/`\simeq` count as `=` when splitting the equation, so re-solving a line that already ends with `\approx 41.14^\circ` works.
- Equations spread over several lines inside display math are handled — the whole `$$...$$` block up to `\solve` is read, not just the current line.
- A trailing `\mathrm{...}` or `\text{...}` on the last expression is treated as a unit and carried over: `=\frac{200}{40}\ \mathrm{rad/m}\solve` gives `k_1=5\ \mathrm{rad/m}`. Otherwise the cursor lands right after the result, ready for typing units.
- Results use up to 6 significant digits; large/small values become `m\cdot 10^{n}`.
- If the expression still contains unknown symbols, a notice appears and nothing changes. Undo restores the `\solve` text without re-triggering.
- The `\quad \to \quad` separator between equation and result is configurable in the settings.
- Text labels before the equation are understood: in `A \he{עבור מתכת}: \lambda = \frac{1240}{2}`, the `:` separates the label from the equation, and leading `\he{...}`/`\text{...}`-style chunks before the variable are ignored even without a colon.
- Tip: the built-in snippet `sol` types `\solve` for you, so solving is three keystrokes.

`\solve` also solves **quadratic and linear equations** in one unknown. If the expression contains a single unknown symbol (a letter like `x` or a Greek command like `\theta`), it is treated as an equation — `= 0` implicitly when no equals sign is present — and both solutions are produced by the quadratic formula:

```latex
x^2+2x+1\solve      →  x^2+2x+1 \quad \to \quad x_{1,2}=-1
x^2-5x+6=0\solve    →  ... \quad \to \quad x_1=3,\ x_2=2
x^2+2x+2\solve      →  ... \quad \to \quad x_{1,2}=-1\pm i
2x+4=0\solve        →  ... \quad \to \quad x=-2
```

A negative discriminant yields the complex pair in `p\pm qi` form. Coefficients can be any evaluable math (`\frac{1}{2}x^2-2=0` works). Cubics and equations with two unknowns are refused with a notice.

## Latex Suite compatibility

If you use Latex Suite's default snippets, modify these lines to avoid conflicts with the hidden braces:

```js
	{trigger: "(", replacement: "($0)$1", options: "mA"},
	{trigger: "{", replacement: "{$0}$1", options: "mA"},
	{trigger: "[", replacement: "[$0]$1", options: "mA"},
```

Remove the `$1` from each `replacement`:

```js
	{trigger: "(", replacement: "($0)", options: "mA"},
	{trigger: "{", replacement: "{$0}", options: "mA"},
	{trigger: "[", replacement: "[$0]", options: "mA"},
```

