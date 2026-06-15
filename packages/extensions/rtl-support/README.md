# RTL Support — Nimbalyst Extension

[English](#english) | [فارسی](#فارسی)

---

## English

> Automatic Right-to-Left (RTL) text direction detection for agent transcripts, user prompts, and markdown content.
> **Resolves [issue #237](https://github.com/nimbalyst/nimbalyst/issues/237).**

### What it does

When prompting agents in RTL languages (Persian, Arabic, Hebrew, etc.), responses were rendered left-to-right, hurting readability. This extension solves it automatically:

- 🎯 **Automatic detection** of dominant text direction per block
- 🔀 **Per-block** — mixed messages (Persian + English code) handled correctly
- 🛡️ **Code blocks protected** — always stay LTR
- ⌨️ **Input fields** — RTL applied to user input as they type
- 🔤 **Inline detection** (optional) — isolates RTL runs within LTR paragraphs
- ⚙️ **Settings panel** — configure without editing JSON
- 🎹 **Keyboard shortcut** — `Ctrl+Shift+R` / `Cmd+Shift+R` to toggle
- 🌐 Supports: Persian, Arabic, Hebrew, Syriac, Thaana, NKo, and more

### Architecture (official Nimbalyst APIs)

| Component | Role |
|-----------|------|
| `detection.ts` | Unicode RTL-range detection algorithm (configurable threshold) |
| `rehypeRtlDetect.ts` | rehype plugin (fallback for standard react-markdown) |
| `RtlTranscriptHost.tsx` | hostComponent — registers transcript markdown contributions with **component overrides** (the working path) |
| `inputRtl.ts` | Applies RTL to user input fields (textarea, contenteditable) |
| `RtlSettingsPanel.tsx` | Settings UI panel inside Nimbalyst Settings |
| `settings.ts` + `index.ts` | Settings management + activate/deactivate + runtime API |

**Key technical insight:** Nimbalyst's `MarkdownRenderer` uses custom React components that ignore hast `properties.dir`. The component overrides (`p`, `li`, `blockquote`, `h1`-`h6`, `table`, `td`, `th`) are required — they detect direction from children and apply `dir` + styles to the DOM directly.

### Installation

```bash
cd nimbalyst-rtl-support
npm install
npm run build
```

Then copy the folder to the user extensions directory:

| OS | Path |
|----|------|
| Windows | `%APPDATA%\@nimbalyst\electron\extensions\` |
| macOS | `~/Library/Application Support/@nimbalyst/electron/extensions/` |
| Linux | `~/.config/@nimbalyst/electron/extensions/` |

Restart Nimbalyst. See [INSTALL.md](./INSTALL.md) for detailed methods.

### Settings

Available via **Settings → RTL Support** panel, or configuration keys:

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enabled` | boolean | `true` | Master on/off |
| `mode` | `auto` \| `rtl` \| `ltr` | `auto` | Auto-detect or force direction |
| `threshold` | number (0..1) | `0.3` | Min RTL ratio for RTL detection |
| `perBlock` | boolean | `true` | Per-block vs per-message |
| `inputRtl` | boolean | `true` | Apply RTL to input fields |
| `inlineDetect` | boolean | `false` | Inline RTL isolation |
| `debug` | boolean | `false` | Console debug logging |

### Verification

Tested on live Nimbalyst: 93 RTL blocks, 88 table cells, 4 tables processed correctly. `direction: rtl` and `text-align: right` confirmed via `getComputedStyle`.

### Development

```bash
npm run build      # build
# for fast iteration, use extension_reload MCP tool:
# extension_reload(extensionId, path)
```

### License

MIT

---

## فارسی

> تشخیص خودکار جهت راست‌به‌چپ (RTL) برای پاسخ‌های agent، prompt کاربر، و محتوای markdown.
> **حل [issue #237](https://github.com/nimbalyst/nimbalyst/issues/237).**

### چه می‌کند

وقتی با زبان‌های RTL (فارسی، عربی، عبری و...) به agent پیام می‌دهیم، پاسخ‌ها چپ‌به‌راست رندر می‌شدند که خوانایی را پایین می‌آورد. این extension آن را به‌صورت خودکار حل می‌کند:

- 🎯 **تشخیص خودکار** جهت غالب متن در هر بلاک
- 🔀 **Per-block** — پیام‌های مخلوط (فارسی + کد انگلیسی) درست هندل می‌شوند
- 🛡️ **بلاک‌های کد محافظت می‌شوند** — همیشه LTR می‌مانند
- ⌨️ **فیلدهای ورودی** — هنگام تایپ فارسی، direction ورودی RTL می‌شود
- 🔤 **تشخیص inline** (اختیاری) — قطعات فارسی داخل پاراگراف انگلیسی isolate می‌شوند
- ⚙️ **پنل تنظیمات** — بدون ویرایش JSON قابل تنظیم
- 🎹 **میانبر صفحه‌کلید** — `Ctrl+Shift+R` برای toggle سریع
- 🌐 پشتیبانی از: فارسی، عربی، عبری، Syriac، Thaana، NKo و بیشتر

### نصب

```bash
cd nimbalyst-rtl-support
npm install
npm run build
```

سپس پوشه را به مسیر extensions کاربر کپی کنید:

| سیستم‌عامل | مسیر |
|-----------|------|
| Windows | `%APPDATA%\@nimbalyst\electron\extensions\` |
| macOS | `~/Library/Application Support/@nimbalyst/electron/extensions/` |
| Linux | `~/.config/@nimbalyst/electron/extensions/` |

Nimbalyst را restart کنید. برای راهنمای کامل [INSTALL.md](./INSTALL.md) را ببینید.

### نکته فنی کلیدی

`MarkdownRenderer` Nimbalyst از component سفارشی استفاده می‌کند که hast `properties.dir` را نادیده می‌گیرد. به همین دلیل، **component override** لازم است — هر component متن children را تحلیل کرده و `dir` + استایل را مستقیماً روی DOM اعمال می‌کند.

### تایید

تست شده روی Nimbalyst واقعی: ۹۳ بلاک RTL، ۸۸ سلول جدول، ۴ جدول به‌درستی پردازش شدند.

### لایسنس

MIT
