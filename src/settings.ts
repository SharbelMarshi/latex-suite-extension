import { App, Platform, PluginSettingTab, Setting, debounce } from "obsidian";
import LatexSuiteExtension from "./main";
import { DEFAULT_ARABIC_FONT, DEFAULT_HEBREW_FONT, DEFAULT_RTL_TEXT_COMMANDS } from "./rtl";


export interface LatexSuiteExtensionSettings {
    disableInTable: boolean;
    disableOnIME: boolean;
    inlineDisplaystyle: boolean;
    solveSeparator: string;
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
    solveSeparator: "\\quad \\to \\quad",
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

    constructor(app: App, plugin: LatexSuiteExtension) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        new Setting(containerEl)
            .setName("Flicker-free inline math")
            .setHeading();

        new Setting(containerEl)
            .setName("Disable in tables")
            .setDesc("If turned on, braces won't be inserted in tables. Decorations & atomic ranges are enabled regardless of this setting.")
            .addToggle((toggle) => {
                toggle.setValue(this.plugin.settings.disableInTable)
                    .onChange(async (disable) => {
                        this.plugin.settings.disableInTable = disable;
                        await this.plugin.saveSettings();
                    })
            });

        new Setting(containerEl)
            .setName("Disable when using IME input")
            .setDesc("This option can be helpful for avoiding some strange behavior occurring when using IME inputs after escaping from a math block with the Latex Suite plugin's tabout feature.")
            .addToggle((toggle) => {
                toggle.setValue(this.plugin.settings.disableOnIME)
                    .onChange(async (disable) => {
                        this.plugin.settings.disableOnIME = disable;
                        await this.plugin.saveSettings();
                    })
            });

        new Setting(containerEl)
            .setName("Math rendering")
            .setHeading();

        new Setting(containerEl)
            .setName("Display style for inline math")
            .setDesc(createFragment((el) => {
                el.createSpan({ text: "Render every inline math as if it started with \"" });
                el.createEl("code", { text: "\\displaystyle" });
                el.createSpan({ text: "\" — full-size fractions, sums and integrals inside $...$. Re-open notes to re-render already displayed math." });
            }))
            .addToggle((toggle) => {
                toggle.setValue(this.plugin.settings.inlineDisplaystyle)
                    .onChange(async (enable) => {
                        this.plugin.settings.inlineDisplaystyle = enable;
                        await this.plugin.saveSettings();
                    })
            });

        new Setting(containerEl)
            .setName("Built-in snippets")
            .setDesc(createFragment((el) => {
                el.createSpan({ text: "In math, \"" });
                el.createEl("code", { text: "he" });
                el.createSpan({ text: "\" expands to \\he{}, \"" });
                el.createEl("code", { text: "ar" });
                el.createSpan({ text: "\" to \\ar{}, and \"" });
                el.createEl("code", { text: "sol" });
                el.createSpan({ text: "\" to \\solve — no Latex Suite configuration needed. Never fires after a letter or backslash (\\theta is safe), inside \\text{...}, or inside \\he{...}/\\ar{...}." });
            }))
            .addToggle((toggle) => {
                toggle.setValue(this.plugin.settings.builtinSnippets)
                    .onChange(async (enable) => {
                        this.plugin.settings.builtinSnippets = enable;
                        await this.plugin.saveSettings();
                    })
            });

        new Setting(containerEl)
            .setName("Solve")
            .setHeading();

        new Setting(containerEl)
            .setName("Result separator")
            .setDesc(createFragment((el) => {
                el.createSpan({ text: "Typing \"" });
                el.createEl("code", { text: "\\solve" });
                el.createSpan({ text: "\" after an equation like \"" });
                el.createEl("code", { text: "k_1=\\frac{200}{40}" });
                el.createSpan({ text: "\" evaluates the last expression and inserts the result (\"" });
                el.createEl("code", { text: "k_1=5" });
                el.createSpan({ text: "\"). This text is inserted between the equation and the result." });
            }))
            .addText(text =>
                text
                    .setPlaceholder("\\quad \\to \\quad")
                    .setValue(this.plugin.settings.solveSeparator)
                    .onChange(debounce(
                        async (val) => {
                            this.plugin.settings.solveSeparator = val;
                            await this.plugin.saveSettings();
                        }, 1000, true))
            );

        new Setting(containerEl)
            .setName("RTL math text")
            .setHeading();

        containerEl.createEl('p', {
            text: 'Each command wraps its argument as RTL text inside math — the \\text{} is built in, so \\he{...} is all you type. Changes may require restarting Obsidian to take full effect.',
            cls: 'setting-item-description'
        });

        new Setting(containerEl)
            .setName("RTL text commands")
            .setDesc(createFragment((el) => {
                el.createSpan({ text: "Comma-separated list. With the default \"he, ar\", writing \"" });
                el.createEl("code", { text: "\\he{שלום}" });
                el.createSpan({ text: "\" renders Hebrew text; nest math inside via \"" });
                el.createEl("code", { text: "\\(...\\)" });
                el.createSpan({ text: "\"." });
            }))
            .addText(text =>
                text
                    .setPlaceholder("e.g. he, ar")
                    .setValue(this.plugin.settings.rtlTextCommands.join(', '))
                    .onChange(debounce(
                        async (val) => {
                            this.plugin.settings.rtlTextCommands = val
                                .split(',')
                                .map(s => s.trim())
                                .filter(Boolean);
                            await this.plugin.saveSettings();
                            await this.plugin.refreshMathJax();
                        }, 2000, true))
            );

        new Setting(containerEl)
            .setName("Hebrew font")
            .setDesc("Font used for Hebrew text inside math. The font must be installed on your system (or provided by an Obsidian theme/snippet).")
            .addText(text =>
                text
                    .setPlaceholder(DEFAULT_HEBREW_FONT)
                    .setValue(this.plugin.settings.hebrewFont)
                    .onChange(debounce(
                        async (val) => {
                            this.plugin.settings.hebrewFont = val.trim();
                            await this.plugin.saveSettings();
                            this.plugin.applyRtlFonts();
                        }, 1000, true))
            );

        new Setting(containerEl)
            .setName("Arabic font")
            .setDesc("Font used for Arabic text inside math. Leave empty to use the default math text font.")
            .addText(text =>
                text
                    .setPlaceholder("e.g. Amiri")
                    .setValue(this.plugin.settings.arabicFont)
                    .onChange(debounce(
                        async (val) => {
                            this.plugin.settings.arabicFont = val.trim();
                            await this.plugin.saveSettings();
                            this.plugin.applyRtlFonts();
                        }, 1000, true))
            );

        if (Platform.isDesktopApp) {
            new Setting(containerEl)
                .setName("Auto-switch keyboard input")
                .setDesc("Switch the system keyboard by cursor position: the note language outside math, the math language inside $...$, and Hebrew/Arabic inside \\he{...} / \\ar{...}. Requires the im-select command-line tool. Tip: bind the \"Toggle keyboard auto-switching\" command to a hotkey to pause this quickly.")
                .addToggle((toggle) => {
                    toggle.setValue(this.plugin.settings.autoSwitchKeyboard)
                        .onChange(async (enable) => {
                            this.plugin.settings.autoSwitchKeyboard = enable;
                            await this.plugin.saveSettings();
                        })
                });

            new Setting(containerEl)
                .setName("im-select path")
                .setDesc("Leave empty to auto-detect (/opt/homebrew/bin/im-select or /usr/local/bin/im-select).")
                .addText(text =>
                    text
                        .setPlaceholder("auto-detect")
                        .setValue(this.plugin.settings.imSelectPath)
                        .onChange(debounce(
                            async (val) => {
                                this.plugin.settings.imSelectPath = val.trim();
                                await this.plugin.saveSettings();
                            }, 1000, true))
                );

            new Setting(containerEl)
                .setName("Hebrew input source")
                .setDesc("Keyboard layout ID used inside \\he{...}. Run im-select in a terminal with the layout active to print its ID.")
                .addText(text =>
                    text
                        .setPlaceholder("com.apple.keylayout.Hebrew")
                        .setValue(this.plugin.settings.hebrewInputSource)
                        .onChange(debounce(
                            async (val) => {
                                this.plugin.settings.hebrewInputSource = val.trim();
                                await this.plugin.saveSettings();
                            }, 1000, true))
                );

            new Setting(containerEl)
                .setName("Arabic input source")
                .setDesc("Keyboard layout ID used inside \\ar{...}.")
                .addText(text =>
                    text
                        .setPlaceholder("com.apple.keylayout.Arabic")
                        .setValue(this.plugin.settings.arabicInputSource)
                        .onChange(debounce(
                            async (val) => {
                                this.plugin.settings.arabicInputSource = val.trim();
                                await this.plugin.saveSettings();
                            }, 1000, true))
                );

            new Setting(containerEl)
                .setName("Math input source")
                .setDesc("Keyboard layout ID used inside $...$ (outside \\he / \\ar). Leave empty to not switch when entering math.")
                .addText(text =>
                    text
                        .setPlaceholder("com.apple.keylayout.ABC")
                        .setValue(this.plugin.settings.mathInputSource)
                        .onChange(debounce(
                            async (val) => {
                                this.plugin.settings.mathInputSource = val.trim();
                                await this.plugin.saveSettings();
                            }, 1000, true))
                );

            new Setting(containerEl)
                .setName("Note input source")
                .setDesc("Keyboard layout ID for regular note text, applied when leaving math — the main language of your notes. Leave empty to not switch outside math.")
                .addText(text =>
                    text
                        .setPlaceholder("com.apple.keylayout.Hebrew")
                        .setValue(this.plugin.settings.noteInputSource)
                        .onChange(debounce(
                            async (val) => {
                                this.plugin.settings.noteInputSource = val.trim();
                                await this.plugin.saveSettings();
                            }, 1000, true))
                );
        }

        new Setting(containerEl)
            .setName("Debug mode")
            .setHeading();

        new Setting(containerEl)
            .setName("Disable decorations")
            .setDesc("If turned on, decorations to hide braces adjacent to dollar signs are disabled. This is especially useful when you want to see what this plugin does under the hood.")
            .addToggle((toggle) => {
                toggle.setValue(this.plugin.settings.disableDecorations)
                    .onChange(async (disable) => {
                        this.plugin.settings.disableDecorations = disable;
                        this.plugin.remakeViewPlugin();
                        await this.plugin.saveSettings();
                    })
            });
        new Setting(containerEl)
            .setName("Disable atomic ranges")
            .setDesc(createFragment((el) => {
                el.createSpan({ text: "If turned on, atomic ranges to treat each of \"" });
                el.createEl("code", { text: "${} " });
                el.createSpan({ text: "\" or \"" });
                el.createEl("code", { text: " {}$" });
                el.createSpan({ text: "\" as one character are disabled." });
            }))
            .addToggle((toggle) => {
                toggle.setValue(this.plugin.settings.disableAtomicRanges)
                    .onChange(async (disable) => {
                        this.plugin.settings.disableAtomicRanges = disable;
                        this.plugin.remakeViewPlugin();
                        await this.plugin.saveSettings();
                    })
            });

        new Setting(containerEl)
            .addButton((button) => {
                button.setButtonText("Restore defaults")
                    .onClick(async () => {
                        this.plugin.settings = structuredClone(DEFAULT_SETTINGS);
                        await this.plugin.saveSettings();
                        this.plugin.remakeViewPlugin();
                        await this.plugin.refreshMathJax();
                        this.plugin.applyRtlFonts();
                        this.display();
                    });
            });
    }
}
