import { App, Platform, PluginSettingTab, SettingDefinitionItem, debounce } from "obsidian";
import LatexSuiteExtension from "./main";
import { DEFAULT_ARABIC_FONT, DEFAULT_HEBREW_FONT, DEFAULT_RTL_TEXT_COMMANDS } from "./rtl";
import { DEFAULT_ANGLE_NAMES } from "./solve-core";


export interface LatexSuiteExtensionSettings {
    disableInTable: boolean;
    disableOnIME: boolean;
    inlineDisplaystyle: boolean;
    autoPairDollar: boolean;
    solveSeparator: string;
    solveAngleUnit: 'degrees' | 'radians';
    solveAngleNames: string[];
    builtinSnippets: boolean;
    rtlTextCommands: string[];
    hebrewFont: string;
    arabicFont: string;
    autoSwitchKeyboard: boolean;
    imSelectPath: string;
    hebrewInputSource: string;
    arabicInputSource: string;
    mathInputSource: string;
    noteInputSource: string;
    disableDecorations: boolean;
    disableAtomicRanges: boolean;
}


export const DEFAULT_SETTINGS: LatexSuiteExtensionSettings = {
    disableInTable: false,
    disableOnIME: true,
    inlineDisplaystyle: true,
    autoPairDollar: true,
    solveSeparator: "\\quad \\to \\quad",
    solveAngleUnit: 'degrees',
    solveAngleNames: DEFAULT_ANGLE_NAMES,
    builtinSnippets: true,
    rtlTextCommands: DEFAULT_RTL_TEXT_COMMANDS,
    hebrewFont: DEFAULT_HEBREW_FONT,
    arabicFont: DEFAULT_ARABIC_FONT,
    autoSwitchKeyboard: true,
    imSelectPath: "",
    hebrewInputSource: "com.apple.keylayout.Hebrew",
    arabicInputSource: "com.apple.keylayout.Arabic",
    mathInputSource: "com.apple.keylayout.ABC",
    noteInputSource: "com.apple.keylayout.Hebrew",
    disableDecorations: false,
    disableAtomicRanges: false,
};


export class LatexSuiteExtensionSettingTab extends PluginSettingTab {
    plugin: LatexSuiteExtension;
    /** re-registering MathJax macros is not free; don't do it per keystroke */
    private refreshMathJaxSoon = debounce(() => {
        void this.plugin.refreshMathJax();
    }, 1000, true);

    constructor(app: App, plugin: LatexSuiteExtension) {
        super(app, plugin);
        this.plugin = plugin;
    }

    getSettingDefinitions(): SettingDefinitionItem[] {
        return [
            {
                type: 'group',
                heading: 'Flicker-free inline math',
                items: [
                    {
                        name: 'Disable in tables',
                        desc: "If turned on, braces won't be inserted in tables. Decorations & atomic ranges are enabled regardless of this setting.",
                        control: { type: 'toggle', key: 'disableInTable' },
                    },
                    {
                        name: 'Disable when using IME input',
                        desc: "This option can be helpful for avoiding some strange behavior occurring when using IME inputs after escaping from a math block with the Latex Suite plugin's tabout feature.",
                        control: { type: 'toggle', key: 'disableOnIME' },
                    },
                ],
            },
            {
                type: 'group',
                heading: 'Math rendering',
                items: [
                    {
                        name: 'Display style for inline math',
                        desc: createFragment((el) => {
                            el.createSpan({ text: "Render every inline math as if it started with \"" });
                            el.createEl("code", { text: "\\displaystyle" });
                            el.createSpan({ text: "\" — full-size fractions, sums and integrals inside $...$. Re-open notes to re-render already displayed math." });
                        }),
                        control: { type: 'toggle', key: 'inlineDisplaystyle' },
                    },
                    {
                        name: 'Auto-close $',
                        desc: createFragment((el) => {
                            el.createSpan({ text: "Typing \"" });
                            el.createEl("code", { text: "$" });
                            el.createSpan({ text: "\" inserts \"" });
                            el.createEl("code", { text: "$|$" });
                            el.createSpan({ text: "\" with the cursor in the middle. Typing \"$\" before a closing \"$\" steps over it, and typing \"$\" with a selection wraps it in $...$." });
                        }),
                        control: { type: 'toggle', key: 'autoPairDollar' },
                    },
                    {
                        name: 'Built-in snippets',
                        desc: createFragment((el) => {
                            el.createSpan({ text: "In math, \"" });
                            el.createEl("code", { text: "he" });
                            el.createSpan({ text: "\" expands to \\he{}, \"" });
                            el.createEl("code", { text: "ar" });
                            el.createSpan({ text: "\" to \\ar{}, and \"" });
                            el.createEl("code", { text: "sol" });
                            el.createSpan({ text: "\" to \\solve — no Latex Suite configuration needed. Never fires after a letter or backslash (\\theta is safe), inside \\text{...}, or inside \\he{...}/\\ar{...}." });
                        }),
                        control: { type: 'toggle', key: 'builtinSnippets' },
                    },
                ],
            },
            {
                type: 'group',
                heading: 'Solve',
                items: [
                    {
                        name: 'Result separator',
                        desc: createFragment((el) => {
                            el.createSpan({ text: "Typing \"" });
                            el.createEl("code", { text: "\\solve" });
                            el.createSpan({ text: "\" after an equation like \"" });
                            el.createEl("code", { text: "k_1=\\frac{200}{40}" });
                            el.createSpan({ text: "\" evaluates the last expression and inserts the result (\"" });
                            el.createEl("code", { text: "k_1=5" });
                            el.createSpan({ text: "\"). This text is inserted between the equation and the result." });
                        }),
                        control: { type: 'text', key: 'solveSeparator', placeholder: "\\quad \\to \\quad" },
                    },
                    {
                        name: 'Angle results',
                        desc: createFragment((el) => {
                            el.createSpan({ text: "When the result is an angle — inverse trig like \"" });
                            el.createEl("code", { text: "\\sin^{-1}(0.5)" });
                            el.createSpan({ text: "\" assigned to an angle-named variable — show it in degrees with \"" });
                            el.createEl("code", { text: "^\\circ" });
                            el.createSpan({ text: "\" or as plain radians." });
                        }),
                        control: {
                            type: 'dropdown',
                            key: 'solveAngleUnit',
                            options: { degrees: 'Degrees', radians: 'Radians' },
                        },
                    },
                    {
                        name: 'Angle variable names',
                        desc: createFragment((el) => {
                            el.createSpan({ text: "Comma-separated variable names that count as angles. \"" });
                            el.createEl("code", { text: "\\theta_{c}=\\sin^{-1}(...)" });
                            el.createSpan({ text: "\" gets degrees; \"" });
                            el.createEl("code", { text: "r_{c}=\\sin^{-1}(...)" });
                            el.createSpan({ text: "\" stays a plain number." });
                        }),
                        control: { type: 'text', key: 'solveAngleNames', placeholder: DEFAULT_ANGLE_NAMES.join(', ') },
                    },
                ],
            },
            {
                type: 'group',
                heading: 'RTL math text',
                items: [
                    {
                        name: 'RTL text commands',
                        desc: createFragment((el) => {
                            el.createSpan({ text: "Each command wraps its argument as RTL text inside math — the \\text{} is built in, so \\he{...} is all you type. Comma-separated list; with the default \"he, ar\", writing \"" });
                            el.createEl("code", { text: "\\he{שלום}" });
                            el.createSpan({ text: "\" renders Hebrew text; nest math inside via \"" });
                            el.createEl("code", { text: "\\(...\\)" });
                            el.createSpan({ text: "\". Changes may require restarting Obsidian to take full effect." });
                        }),
                        control: { type: 'text', key: 'rtlTextCommands', placeholder: 'e.g. he, ar' },
                    },
                    {
                        name: 'Hebrew font',
                        desc: 'Font used for Hebrew text inside math. The font must be installed on your system (or provided by an Obsidian theme/snippet).',
                        control: { type: 'text', key: 'hebrewFont', placeholder: DEFAULT_HEBREW_FONT },
                    },
                    {
                        name: 'Arabic font',
                        desc: 'Font used for Arabic text inside math. Leave empty to use the default math text font.',
                        control: { type: 'text', key: 'arabicFont', placeholder: 'e.g. Amiri' },
                    },
                ],
            },
            {
                type: 'group',
                heading: 'Keyboard switching',
                visible: () => Platform.isDesktopApp,
                items: [
                    {
                        name: 'Auto-switch keyboard input',
                        desc: "Switch the system keyboard by cursor position: the note language outside math, the math language inside $...$, and Hebrew/Arabic inside \\he{...} / \\ar{...}. Requires the im-select command-line tool. Tip: bind the \"Toggle keyboard auto-switching\" command to a hotkey to pause this quickly.",
                        control: { type: 'toggle', key: 'autoSwitchKeyboard' },
                    },
                    {
                        name: 'im-select path',
                        desc: 'Leave empty to auto-detect (/opt/homebrew/bin/im-select or /usr/local/bin/im-select).',
                        control: { type: 'text', key: 'imSelectPath', placeholder: 'auto-detect' },
                    },
                    {
                        name: 'Hebrew input source',
                        desc: 'Keyboard layout ID used inside \\he{...}. Run im-select in a terminal with the layout active to print its ID.',
                        control: { type: 'text', key: 'hebrewInputSource', placeholder: 'com.apple.keylayout.Hebrew' },
                    },
                    {
                        name: 'Arabic input source',
                        desc: 'Keyboard layout ID used inside \\ar{...}.',
                        control: { type: 'text', key: 'arabicInputSource', placeholder: 'com.apple.keylayout.Arabic' },
                    },
                    {
                        name: 'Math input source',
                        desc: 'Keyboard layout ID used inside $...$ (outside \\he / \\ar). Leave empty to not switch when entering math.',
                        control: { type: 'text', key: 'mathInputSource', placeholder: 'com.apple.keylayout.ABC' },
                    },
                    {
                        name: 'Note input source',
                        desc: 'Keyboard layout ID for regular note text, applied when leaving math — the main language of your notes. Leave empty to not switch outside math.',
                        control: { type: 'text', key: 'noteInputSource', placeholder: 'com.apple.keylayout.Hebrew' },
                    },
                ],
            },
            {
                type: 'group',
                heading: 'Debug mode',
                items: [
                    {
                        name: 'Disable decorations',
                        desc: 'If turned on, decorations to hide braces adjacent to dollar signs are disabled. This is especially useful when you want to see what this plugin does under the hood.',
                        control: { type: 'toggle', key: 'disableDecorations' },
                    },
                    {
                        name: 'Disable atomic ranges',
                        desc: createFragment((el) => {
                            el.createSpan({ text: "If turned on, atomic ranges to treat each of \"" });
                            el.createEl("code", { text: "${} " });
                            el.createSpan({ text: "\" or \"" });
                            el.createEl("code", { text: " {}$" });
                            el.createSpan({ text: "\" as one character are disabled." });
                        }),
                        control: { type: 'toggle', key: 'disableAtomicRanges' },
                    },
                    {
                        name: 'Restore defaults',
                        desc: 'Reset every setting of this plugin to its default value.',
                        action: () => {
                            void this.restoreDefaults();
                        },
                    },
                ],
            },
        ];
    }

    getControlValue(key: string): unknown {
        if (key === 'rtlTextCommands' || key === 'solveAngleNames') {
            return this.plugin.settings[key].join(', ');
        }
        return this.plugin.settings[key as keyof LatexSuiteExtensionSettings];
    }

    async setControlValue(key: string, value: unknown): Promise<void> {
        const settings = this.plugin.settings;

        if (key === 'rtlTextCommands' || key === 'solveAngleNames') {
            if (typeof value !== 'string') return;
            settings[key] = value.split(',').map(s => s.trim()).filter(Boolean);
        } else if (typeof value === 'string') {
            // the solve separator may intentionally end with a space
            (settings as unknown as Record<string, string>)[key] =
                key === 'solveSeparator' ? value : value.trim();
        } else if (typeof value === 'boolean') {
            (settings as unknown as Record<string, boolean>)[key] = value;
        } else {
            return;
        }

        await this.plugin.saveSettings();

        switch (key) {
            case 'disableDecorations':
            case 'disableAtomicRanges':
                this.plugin.remakeViewPlugin();
                break;
            case 'rtlTextCommands':
                this.refreshMathJaxSoon();
                break;
            case 'hebrewFont':
            case 'arabicFont':
                this.plugin.applyRtlFonts();
                break;
        }
    }

    private async restoreDefaults() {
        this.plugin.settings = structuredClone(DEFAULT_SETTINGS);
        await this.plugin.saveSettings();
        this.plugin.remakeViewPlugin();
        await this.plugin.refreshMathJax();
        this.plugin.applyRtlFonts();
        this.update();
    }
}
