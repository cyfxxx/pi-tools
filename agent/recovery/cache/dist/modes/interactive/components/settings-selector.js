import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { Container, getCapabilities, SettingsList, Spacer, Text, } from "@earendil-works/pi-tui";
import { formatHttpIdleTimeoutMs, HTTP_IDLE_TIMEOUT_CHOICES } from "../../../core/http-dispatcher.js";
import { getSettingsListTheme, parseAutoThemeSetting, theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";
import { keyDisplayText } from "./keybinding-hints.js";
import { SelectSubmenu, SteppedSubmenu } from "./settings-submenu.js";
const MODEL_PICKER_LAYOUT = { minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 46 };
const THINKING_DESCRIPTIONS = {
    off: `无推理`,
    minimal: `极简推理（约 1K token）`,
    low: `轻度推理（约 2K token）`,
    medium: `中等推理（约 8K token）`,
    high: `深度推理（约 16K token）`,
    xhigh: `最大推理（约 32K token）`,
    max: `最大推理`,
};
const DEFAULT_PROJECT_TRUST_LABELS = {
    ask: "询问",
    always: "始终信任",
    never: "永不信任",
};
const DEFAULT_PROJECT_TRUST_BY_LABEL = new Map(Object.entries(DEFAULT_PROJECT_TRUST_LABELS).map(([value, label]) => [label, value]));
/**
 * A submenu component for selecting from a list of options.
 */
class WarningSettingsSubmenu extends Container {
    settingsList;
    state;
    constructor(warnings, onChange, onCancel) {
        super();
        this.state = { ...warnings };
        const items = [
            {
                id: "anthropic-extra-usage",
                label: `Anthropic 额外用量`,
                description: `当 Anthropic 订阅认证可能产生付费额外用量时发出警告`,
                currentValue: (this.state.anthropicExtraUsage ?? true) ? "true" : "false",
                values: ["true", "false"],
            },
        ];
        this.settingsList = new SettingsList(items, Math.min(items.length, 10), getSettingsListTheme(), (id, newValue) => {
            switch (id) {
                case "anthropic-extra-usage":
                    this.state = { ...this.state, anthropicExtraUsage: newValue === "true" };
                    onChange({ ...this.state });
                    break;
            }
        }, onCancel);
        this.addChild(this.settingsList);
    }
    handleInput(data) {
        this.settingsList.handleInput(data);
    }
}
const CLEAR_OVERRIDE_VALUE = "__clear__";
function modelSettingKey(model) {
    return `${model.provider}/${model.id}`;
}
function modelDisplayLabel(model) {
    return `${model.id} [${model.provider}]`;
}
function modelThinkingOverridesSummary(overrides) {
    const count = Object.keys(overrides).length;
    if (count === 0)
        return "none";
    return `${count} configured`;
}
function modelItemLabel(model) {
    return `${model.id} ${theme.fg("muted", `[${model.provider}]`)}`;
}
function themeItems(availableThemes, currentTheme) {
    return availableThemes.map((name) => ({
        value: name,
        label: `${name === currentTheme ? "✓ " : "  "}${name}`,
    }));
}
const AUTOMATIC_THEME_VALUE = "/";
function singleModeThemeItems(availableThemes, currentTheme) {
    return [
        {
            value: AUTOMATIC_THEME_VALUE,
            label: "  Automatic",
            description: `为浅色和深色终端分别使用不同主题`,
        },
        ...themeItems(availableThemes, currentTheme),
    ];
}
function preferredTheme(availableThemes, preferred, fallback) {
    if (preferred && availableThemes.includes(preferred))
        return preferred;
    if (availableThemes.includes(fallback))
        return fallback;
    return availableThemes[0] ?? fallback;
}
function defaultAutomaticThemes(currentThemeSetting, availableThemes) {
    const autoTheme = parseAutoThemeSetting(currentThemeSetting);
    if (autoTheme)
        return autoTheme;
    const currentFixedTheme = currentThemeSetting.includes("/") ? undefined : currentThemeSetting;
    const themeName = preferredTheme(availableThemes, currentFixedTheme, "dark");
    return { lightTheme: themeName, darkTheme: themeName };
}
class ThemeSubmenu extends Container {
    inputComponent;
    callbacks;
    availableThemes;
    terminalTheme;
    onDone;
    originalThemeSetting;
    mode;
    singleTheme;
    lightTheme;
    darkTheme;
    constructor(currentThemeSetting, terminalTheme, availableThemes, callbacks, onDone) {
        super();
        this.callbacks = callbacks;
        this.availableThemes = availableThemes;
        this.terminalTheme = terminalTheme;
        this.onDone = onDone;
        this.originalThemeSetting = currentThemeSetting;
        const autoTheme = parseAutoThemeSetting(currentThemeSetting);
        const automaticThemes = defaultAutomaticThemes(currentThemeSetting, availableThemes);
        const fixedTheme = autoTheme || currentThemeSetting.includes("/") ? undefined : currentThemeSetting;
        this.mode = autoTheme ? "automatic" : "single";
        this.lightTheme = automaticThemes.lightTheme;
        this.darkTheme = automaticThemes.darkTheme;
        this.singleTheme = preferredTheme(availableThemes, fixedTheme ?? (autoTheme ? this.getActiveAutomaticTheme() : undefined), "dark");
        if (this.mode === "automatic") {
            this.showAutomaticMenu();
        }
        else {
            this.showSingleMenu();
        }
    }
    handleInput(data) {
        this.inputComponent?.handleInput?.(data);
    }
    setContent(renderComponent, inputComponent = renderComponent) {
        this.clear();
        this.addChild(renderComponent);
        this.inputComponent = inputComponent;
    }
    showSingleMenu() {
        this.mode = "single";
        const menu = new SelectSubmenu("主题", "Select a theme, or choose Automatic to follow terminal appearance.", singleModeThemeItems(this.availableThemes, this.singleTheme), this.singleTheme, (value) => {
            if (value === AUTOMATIC_THEME_VALUE) {
                this.mode = "automatic";
                this.callbacks.onThemePreview?.(this.getThemeSetting());
                this.showAutomaticMenu();
                return;
            }
            this.singleTheme = value;
            this.apply(value);
        }, () => this.cancel(), (value) => {
            this.callbacks.onThemePreview?.(value === AUTOMATIC_THEME_VALUE ? this.getAutomaticThemeSetting() : value);
        });
        this.setContent(menu);
    }
    showAutomaticMenu() {
        this.mode = "automatic";
        const content = new Container();
        content.addChild(new Text(theme.bold(theme.fg("accent", "Automatic Theme")), 0, 0));
        content.addChild(new Spacer(1));
        content.addChild(new Text(theme.fg("muted", "Choose themes for terminal light and dark appearance."), 0, 0));
        content.addChild(new Text(theme.fg("muted", "Light/dark detection requires terminal support."), 0, 0));
        content.addChild(new Spacer(1));
        const items = [
            {
                id: "light-theme",
                label: `浅色主题`,
                description: `终端为浅色时自动模式使用的主题`,
                currentValue: this.lightTheme,
                submenu: (currentValue, done) => this.createThemeSelect("Light Theme", "Select the theme to use for light terminal appearance", currentValue, done, (value) => {
                    this.lightTheme = value;
                    this.callbacks.onThemePreview?.(this.getThemeSetting());
                    done(value);
                }),
            },
            {
                id: "dark-theme",
                label: `深色主题`,
                description: `终端为深色时自动模式使用的主题`,
                currentValue: this.darkTheme,
                submenu: (currentValue, done) => this.createThemeSelect("Dark Theme", "Select the theme to use for dark terminal appearance", currentValue, done, (value) => {
                    this.darkTheme = value;
                    this.callbacks.onThemePreview?.(this.getThemeSetting());
                    done(value);
                }),
            },
            {
                id: "apply",
                label: `应用`,
                description: `保存并返回`,
                currentValue: "save and go back",
                values: ["save and go back"],
            },
            {
                id: "single-mode",
                label: `切换模式`,
                description: `切换为浅色深色共用同一主题`,
                currentValue: "switch to single theme",
                values: ["switch to single theme"],
            },
        ];
        const settingsList = new SettingsList(items, Math.min(items.length, 10), getSettingsListTheme(), (id) => {
            switch (id) {
                case "single-mode":
                    this.mode = "single";
                    this.singleTheme = this.getActiveAutomaticTheme();
                    this.callbacks.onThemePreview?.(this.singleTheme);
                    this.showSingleMenu();
                    break;
                case "apply":
                    this.apply(this.getAutomaticThemeSetting());
                    break;
            }
        }, () => this.cancel());
        content.addChild(settingsList);
        this.setContent(content, settingsList);
    }
    createThemeSelect(title, description, currentValue, done, onSelect) {
        return new SelectSubmenu(title, description, themeItems(this.availableThemes, currentValue), currentValue, onSelect, () => {
            this.callbacks.onThemePreview?.(this.getThemeSetting());
            done();
        }, (value) => this.callbacks.onThemePreview?.(value));
    }
    getThemeSetting() {
        return this.mode === "automatic" ? this.getAutomaticThemeSetting() : this.singleTheme;
    }
    getActiveAutomaticTheme() {
        return this.terminalTheme === "light" ? this.lightTheme : this.darkTheme;
    }
    getAutomaticThemeSetting() {
        return `${this.lightTheme}/${this.darkTheme}`;
    }
    apply(themeSetting) {
        this.onDone(themeSetting);
    }
    cancel() {
        this.callbacks.onThemePreview?.(this.originalThemeSetting);
        this.onDone();
    }
}
/**
 * Main settings selector component.
 */
export class SettingsSelectorComponent extends Container {
    settingsList;
    constructor(config, callbacks) {
        super();
        const supportsImages = getCapabilities().images;
        const followUpKey = keyDisplayText("app.message.followUp");
        const cycleThinkingKey = keyDisplayText("app.thinking.cycle");
        let currentWarnings = { ...config.warnings };
        const currentModelThinkingLevels = { ...config.modelThinkingLevels };
        const defaultModelByValue = new Map(config.availableDefaultModels.map((model) => [modelSettingKey(model), model]));
        const currentDefaultModelKey = defaultModelByValue.has(config.defaultModel) ? config.defaultModel : undefined;
        const currentModelKey = config.currentModel ? modelSettingKey(config.currentModel) : undefined;
        const items = [
            {
                id: "autocompact",
                label: `自动压缩`,
                description: `上下文过大时自动压缩`,
                currentValue: config.autoCompact ? "true" : "false",
                values: ["true", "false"],
            },
            {
                id: "steering-mode",
                label: `引导模式`,
                description: `流式输出时按 Enter 排队引导消息。"one-at-a-time"：逐个发送并等待回复；"all"：全部一次发送`,
                currentValue: config.steeringMode,
                values: ["one-at-a-time", "all"],
            },
            {
                id: "follow-up-mode",
                label: `跟进模式`,
                description: `跟进消息排队直到代理停止。"one-at-a-time"：逐个发送并等待回复；"all"：全部一次发送`,
                currentValue: config.followUpMode,
                values: ["one-at-a-time", "all"],
            },
            {
                id: "transport",
                label: `传输协议`,
                description: `多传输协议提供商的首选传输方式`,
                currentValue: config.transport,
                values: ["sse", "websocket", "websocket-cached", "auto"],
            },
            {
                id: "http-idle-timeout",
                label: `HTTP 空闲超时`,
                description: `等待 HTTP 标头或数据块时的最大空闲间隙。本地模型暂停超 5 分钟时请关闭此选项`,
                currentValue: formatHttpIdleTimeoutMs(config.httpIdleTimeoutMs),
                values: HTTP_IDLE_TIMEOUT_CHOICES.map((choice) => choice.label),
            },
            {
                id: "hide-thinking",
                label: `隐藏思考过程`,
                description: `隐藏助手回复中的思考块`,
                currentValue: config.hideThinkingBlock ? "true" : "false",
                values: ["true", "false"],
            },
            {
                id: "mermaid-rendering",
                label: `Mermaid 图表`,
                description: `将 Mermaid 代码块渲染为 Unicode 图表`,
                currentValue: config.mermaidRenderingMode,
                values: ["off", "final", "streaming"],
            },
            {
                id: "cache-miss-notices",
                label: `缓存未命中通知`,
                description: `显示缓存成本和提供者恢复诊断的通知`,
                currentValue: config.showCacheMissNotices ? "true" : "false",
                values: ["true", "false"],
            },
            {
                id: "collapse-changelog",
                label: `折叠更新日志`,
                description: `更新后显示精简版更新日志`,
                currentValue: config.collapseChangelog ? "true" : "false",
                values: ["true", "false"],
            },
            {
                id: "quiet-startup",
                label: `静默启动`,
                description: `启动时不打印详细信息`,
                currentValue: config.quietStartup ? "true" : "false",
                values: ["true", "false"],
            },
            {
                id: "install-telemetry",
                label: `安装遥测`,
                description: `在检测到更新后发送匿名版本/更新通知`,
                currentValue: config.enableInstallTelemetry ? "true" : "false",
                values: ["true", "false"],
            },
            {
                id: "default-project-trust",
                label: `默认项目信任`,
                description: `当扩展或已保存的信任决策未决定项目信任时的回退行为`,
                currentValue: DEFAULT_PROJECT_TRUST_LABELS[config.defaultProjectTrust],
                values: Object.values(DEFAULT_PROJECT_TRUST_LABELS),
            },
            {
                id: "double-escape-action",
                label: `双击 Esc 动作`,
                description: `编辑器为空时双击 Esc 触发的动作`,
                currentValue: config.doubleEscapeAction,
                values: ["tree", "fork", "none"],
            },
            {
                id: "tree-filter-mode",
                label: `树过滤器模式`,
                description: `打开 /tree 时的默认过滤器`,
                currentValue: config.treeFilterMode,
                values: ["default", "no-tools", "user-only", "labeled-only", "all"],
            },
            {
                id: "warnings",
                label: `警告`,
                description: `启用或禁用单个警告`,
                currentValue: "configure",
                submenu: (_currentValue, done) => new WarningSettingsSubmenu(currentWarnings, (warnings) => {
                    currentWarnings = warnings;
                    callbacks.onWarningsChange(warnings);
                }, () => done()),
            },
            {
                id: "model-thinking",
                label: `按模型默认思考深度`,
                description: `为特定模型覆盖默认思考深度。会话内按 ${cycleThinkingKey} 循环切换。`,
                currentValue: modelThinkingOverridesSummary(currentModelThinkingLevels),
                submenu: (_currentValue, done) => {
                    const steps = [
                        {
                            key: "model",
                            title: "Per-Model Thinking Level",
                            description: `选择要配置的模型`,
                            options: () => {
                                const sorted = [...config.availableDefaultModels].sort((a, b) => {
                                    const aKey = modelSettingKey(a);
                                    const bKey = modelSettingKey(b);
                                    if (aKey === currentModelKey)
                                        return -1;
                                    if (bKey === currentModelKey)
                                        return 1;
                                    if (aKey === currentDefaultModelKey)
                                        return -1;
                                    if (bKey === currentDefaultModelKey)
                                        return 1;
                                    return a.provider.localeCompare(b.provider);
                                });
                                const items = sorted.map((model) => {
                                    const key = modelSettingKey(model);
                                    const override = currentModelThinkingLevels[key];
                                    return {
                                        value: key,
                                        label: modelItemLabel(model),
                                        description: override ?? undefined,
                                    };
                                });
                                if (items.length === 0) {
                                    items.push({
                                        value: "__none__",
                                        label: "No models available",
                                        description: `请先登录提供商或配置 API 密钥`,
                                    });
                                }
                                return items;
                            },
                            preselect: () => currentModelKey ?? currentDefaultModelKey,
                            searchable: true,
                            layout: MODEL_PICKER_LAYOUT,
                        },
                        {
                            key: "level",
                            title: (ctx) => {
                                const m = defaultModelByValue.get(ctx.model);
                                return `Thinking Level for ${m ? modelDisplayLabel(m) : ctx.model}`;
                            },
                            description: `选择此模型的默认思考深度`,
                            options: (ctx) => {
                                const model = defaultModelByValue.get(ctx.model);
                                if (!model)
                                    return [];
                                const levels = (model.reasoning ? getSupportedThinkingLevels(model) : ["off"]);
                                const activeLevel = currentModelThinkingLevels[ctx.model];
                                const items = levels.map((level) => ({
                                    value: level,
                                    label: `${level === activeLevel ? "✓ " : "  "}${level}`,
                                    description: THINKING_DESCRIPTIONS[level],
                                }));
                                if (currentModelThinkingLevels[ctx.model] !== undefined) {
                                    items.push({
                                        value: CLEAR_OVERRIDE_VALUE,
                                        label: "  (clear override)",
                                        description: `恢复全局默认（${config.thinkingLevel}）`,
                                    });
                                }
                                return items;
                            },
                            preselect: (ctx) => currentModelThinkingLevels[ctx.model],
                        },
                    ];
                    const summary = () => modelThinkingOverridesSummary(currentModelThinkingLevels);
                    return new SteppedSubmenu(steps, (selections) => {
                        const model = defaultModelByValue.get(selections.model);
                        if (!model)
                            return;
                        if (selections.level === CLEAR_OVERRIDE_VALUE) {
                            callbacks.onModelThinkingLevelRemove(model.provider, model.id);
                            delete currentModelThinkingLevels[selections.model];
                        }
                        else {
                            callbacks.onModelThinkingLevelChange(model.provider, model.id, selections.level);
                            currentModelThinkingLevels[selections.model] = selections.level;
                        }
                    }, () => {
                        done(summary());
                    }, { loop: true });
                },
            },
            {
                id: "tui-mode",
                label: `TUI 模式`,
                description: `界面布局；全屏模式为实验性功能`,
                currentValue: config.tuiMode,
                values: ["regular", "fullscreen"],
            },
            {
                id: "fullscreen-exit-output",
                label: "Fullscreen exit output",
                description: `退出全屏模式时输出完整对话记录或仅会话恢复提示`,
                currentValue: config.fullscreenExitOutput,
                values: ["transcript", "resume-hint"],
            },
            {
                id: "fullscreen-scrollbar",
                label: `全屏滚动条`,
                description: `全屏模式下的滚动条行为；在常规模式下无效果`,
                currentValue: config.fullscreenScrollbar,
                values: ["auto", "always", "hidden"],
            },
            {
                id: "fullscreen-copy-on-select",
                label: "Fullscreen copy on select",
                description: `在全屏模式下自动复制所选文本；禁用后可使用 Ctrl+X 复制所选文本`,
                currentValue: config.fullscreenCopyOnSelect ? "true" : "false",
                values: ["true", "false"],
            },
            {
                id: "theme",
                label: `主题`,
                description: `界面颜色主题`,
                currentValue: config.currentTheme,
                submenu: (currentValue, done) => new ThemeSubmenu(currentValue, config.terminalTheme, config.availableThemes, callbacks, done),
            },
        ];
        // Only show image toggle if terminal supports it
        if (supportsImages) {
            // Insert after autocompact
            items.splice(1, 0, {
                id: "show-images",
                label: `显示图片`,
                description: `在终端内联渲染图片`,
                currentValue: config.showImages ? "true" : "false",
                values: ["true", "false"],
            });
            items.splice(2, 0, {
                id: "image-width-cells",
                label: `图片宽度`,
                description: `内联图片在终端中的首选宽度（单位：字符列数）`,
                currentValue: String(config.imageWidthCells),
                values: ["60", "80", "120"],
            });
        }
        // Image auto-resize toggle (always available, affects both attached and read images)
        items.splice(supportsImages ? 3 : 1, 0, {
            id: "auto-resize-images",
            label: `自动缩放图片`,
            description: `将大图缩放到最大 2000x2000 以提升模型兼容性`,
            currentValue: config.autoResizeImages ? "true" : "false",
            values: ["true", "false"],
        });
        // Block images toggle (always available, insert after auto-resize-images)
        const autoResizeIndex = items.findIndex((item) => item.id === "auto-resize-images");
        items.splice(autoResizeIndex + 1, 0, {
            id: "block-images",
            label: `拦截图片`,
            description: `阻止图片发送给 LLM 提供商`,
            currentValue: config.blockImages ? "true" : "false",
            values: ["true", "false"],
        });
        // Skill commands toggle (insert after block-images)
        const blockImagesIndex = items.findIndex((item) => item.id === "block-images");
        items.splice(blockImagesIndex + 1, 0, {
            id: "skill-commands",
            label: `技能命令`,
            description: `将技能注册为 /skill:name 命令`,
            currentValue: config.enableSkillCommands ? "true" : "false",
            values: ["true", "false"],
        });
        // Hardware cursor toggle (insert after skill-commands)
        const skillCommandsIndex = items.findIndex((item) => item.id === "skill-commands");
        items.splice(skillCommandsIndex + 1, 0, {
            id: "show-hardware-cursor",
            label: `显示硬件光标`,
            description: `显示终端光标（同时定位以支持 IME）`,
            currentValue: config.showHardwareCursor ? "true" : "false",
            values: ["true", "false"],
        });
        // Editor padding toggle (insert after show-hardware-cursor)
        const hardwareCursorIndex = items.findIndex((item) => item.id === "show-hardware-cursor");
        items.splice(hardwareCursorIndex + 1, 0, {
            id: "editor-padding",
            label: `编辑器内边距`,
            description: `输入编辑器的水平内边距（0-3）`,
            currentValue: String(config.editorPaddingX),
            values: ["0", "1", "2", "3"],
        });
        // Output padding toggle (insert after editor-padding)
        const editorPaddingIndex = items.findIndex((item) => item.id === "editor-padding");
        items.splice(editorPaddingIndex + 1, 0, {
            id: "output-padding",
            label: `输出内边距`,
            description: `用户消息、助手消息和思考内容的水平内边距`,
            currentValue: String(config.outputPad),
            values: ["0", "1"],
        });
        // Autocomplete max visible toggle (insert after output-padding)
        const outputPaddingIndex = items.findIndex((item) => item.id === "output-padding");
        items.splice(outputPaddingIndex + 1, 0, {
            id: "autocomplete-max-visible",
            label: `自动补全最大显示数`,
            description: `自动补全下拉列表的最大可见项数（3-20）`,
            currentValue: String(config.autocompleteMaxVisible),
            values: ["3", "5", "7", "10", "15", "20"],
        });
        // Clear on shrink toggle (insert after autocomplete-max-visible)
        const autocompleteIndex = items.findIndex((item) => item.id === "autocomplete-max-visible");
        items.splice(autocompleteIndex + 1, 0, {
            id: "clear-on-shrink",
            label: `收缩时清空`,
            description: `内容收缩时清空空行（可能导致闪烁）`,
            currentValue: config.clearOnShrink ? "true" : "false",
            values: ["true", "false"],
        });
        // Terminal progress toggle (insert after clear-on-shrink)
        const clearOnShrinkIndex = items.findIndex((item) => item.id === "clear-on-shrink");
        items.splice(clearOnShrinkIndex + 1, 0, {
            id: "terminal-progress",
            label: `终端进度条`,
            description: `在终端标签栏显示 OSC 9;4 进度指示器`,
            currentValue: config.showTerminalProgress ? "true" : "false",
            values: ["true", "false"],
        });
        // Add borders
        this.addChild(new DynamicBorder());
        this.settingsList = new SettingsList(items, 10, getSettingsListTheme(), (id, newValue) => {
            switch (id) {
                case "autocompact":
                    callbacks.onAutoCompactChange(newValue === "true");
                    break;
                case "show-images":
                    callbacks.onShowImagesChange(newValue === "true");
                    break;
                case "image-width-cells":
                    callbacks.onImageWidthCellsChange(parseInt(newValue, 10));
                    break;
                case "auto-resize-images":
                    callbacks.onAutoResizeImagesChange(newValue === "true");
                    break;
                case "block-images":
                    callbacks.onBlockImagesChange(newValue === "true");
                    break;
                case "skill-commands":
                    callbacks.onEnableSkillCommandsChange(newValue === "true");
                    break;
                case "steering-mode":
                    callbacks.onSteeringModeChange(newValue);
                    break;
                case "follow-up-mode":
                    callbacks.onFollowUpModeChange(newValue);
                    break;
                case "transport":
                    callbacks.onTransportChange(newValue);
                    break;
                case "http-idle-timeout": {
                    const choice = HTTP_IDLE_TIMEOUT_CHOICES.find((item) => item.label === newValue);
                    if (choice) {
                        callbacks.onHttpIdleTimeoutMsChange(choice.timeoutMs);
                    }
                    break;
                }
                case "hide-thinking":
                    callbacks.onHideThinkingBlockChange(newValue === "true");
                    break;
                case "mermaid-rendering":
                    callbacks.onMermaidRenderingModeChange(newValue);
                    break;
                case "cache-miss-notices":
                    callbacks.onShowCacheMissNoticesChange(newValue === "true");
                    break;
                case "collapse-changelog":
                    callbacks.onCollapseChangelogChange(newValue === "true");
                    break;
                case "quiet-startup":
                    callbacks.onQuietStartupChange(newValue === "true");
                    break;
                case "install-telemetry":
                    callbacks.onEnableInstallTelemetryChange(newValue === "true");
                    break;
                case "default-project-trust": {
                    const defaultProjectTrust = DEFAULT_PROJECT_TRUST_BY_LABEL.get(newValue);
                    if (defaultProjectTrust) {
                        callbacks.onDefaultProjectTrustChange(defaultProjectTrust);
                    }
                    break;
                }
                case "double-escape-action":
                    callbacks.onDoubleEscapeActionChange(newValue);
                    break;
                case "tree-filter-mode":
                    callbacks.onTreeFilterModeChange(newValue);
                    break;
                case "show-hardware-cursor":
                    callbacks.onShowHardwareCursorChange(newValue === "true");
                    break;
                case "editor-padding":
                    callbacks.onEditorPaddingXChange(parseInt(newValue, 10));
                    break;
                case "output-padding":
                    callbacks.onOutputPadChange(newValue === "0" ? 0 : 1);
                    break;
                case "autocomplete-max-visible":
                    callbacks.onAutocompleteMaxVisibleChange(parseInt(newValue, 10));
                    break;
                case "clear-on-shrink":
                    callbacks.onClearOnShrinkChange(newValue === "true");
                    break;
                case "terminal-progress":
                    callbacks.onShowTerminalProgressChange(newValue === "true");
                    break;
                case "tui-mode":
                    callbacks.onTuiModeChange(newValue);
                    break;
                case "fullscreen-exit-output":
                    callbacks.onFullscreenExitOutputChange(newValue);
                    break;
                case "fullscreen-scrollbar":
                    callbacks.onFullscreenScrollbarChange(newValue);
                    break;
                case "fullscreen-copy-on-select":
                    callbacks.onFullscreenCopyOnSelectChange(newValue === "true");
                    break;
                case "theme":
                    callbacks.onThemeChange(newValue);
                    break;
            }
        }, callbacks.onCancel, { enableSearch: true });
        this.addChild(this.settingsList);
        this.addChild(new DynamicBorder());
    }
    getSettingsList() {
        return this.settingsList;
    }
}
//# sourceMappingURL=settings-selector.js.map