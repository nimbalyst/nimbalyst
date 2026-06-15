# 📥 راهنمای نصب RTL Support Extension

نصب extension روی یه سیستم دیگه. سه روش — بسته به نیازت یکی رو انتخاب کن.

## پیش‌نیازها (همه روش‌ها)

- **Node.js ≥ 18** ([nodejs.org](https://nodejs.org))
- **Nimbalyst** نصب شده و حداقل یه بار اجرا شده

---

## روش ۱: از طریق Nimbalyst (ساده‌ترین — توصیه‌شده) ⭐

این روش بهترینه چون Nimbalyst خودش build و symlink می‌کنه.

### مراحل

1. **کلیه فایل‌های سورس** رو به سیستم هدف کپی کن (پوشه `nimbalyst-rtl-support`).
   - نیازی به `node_modules/` یا `dist/` نیست — Nimbalyst خودش می‌سازه.
   - می‌تونی از GitHub clone یا zip استفاده کنی.

2. **Extension Dev Tools رو فعال کن**:
   - `Settings` → `Advanced` → `Extension Dev Tools` رو روشن کن.

3. **نصب کن** — یکی از این روش‌ها:
   - **از Nimbalyst CLI**: از یه agent بگو: *"extension با مسیر `<مسیر>` رو نصب کن"*
   - **با MCP tool** (اگه دسترسی داری): `extension_install(path: "<مسیر>")`

4. **منتظر بمون** تا build کامل بشه (چند ثانیه).

5. ✅ تمام! Extension فعال شد. یه پیام فارسی به agent بفرست تا ببینی RTL کار می‌کنه.

---

## روش ۲: نصب دستی با build

اگه روش ۱ جواب نداد یا Dev Tools فعال نیست.

### مراحل

1. **پوشه سورس** رو به سیستم هدف کپی کن.

2. **Build کن**:
   ```bash
   cd nimbalyst-rtl-support
   npm install
   npm run build
   ```
   بعد از build، پوشه `dist/` ساخته می‌شه.

3. **پوشه extension رو به مسیر extensions کاربر کپی کن:**

   | سیستم‌عامل | مسیر |
   |-----------|------|
   | **Windows** | `%APPDATA%\@nimbalyst\electron\extensions\` |
   | **macOS** | `~/Library/Application Support/@nimbalyst/electron/extensions/` |
   | **Linux** | `~/.config/@nimbalyst/electron/extensions/` |

   اسم پوشه باید `nimbalyst-rtl-support` باشه (یا `com.nimbalyst.rtl-support`).

   **مثال Windows (PowerShell):**
   ```powershell
   Copy-Item -Path "C:\path\to\nimbalyst-rtl-support" `
             -Destination "$env:APPDATA\@nimbalyst\electron\extensions\" `
             -Recurse
   ```

   **مثال macOS/Linux:**
   ```bash
   cp -r nimbalyst-rtl-support \
     ~/Library/Application\ Support/@nimbalyst/electron/extensions/
   # یا روی لینوکس: ~/.config/@nimbalyst/electron/extensions/
   ```

4. **Nimbalyst رو restart کن.**

5. ✅ تمام! در startup لود می‌شه.

---

## روش ۳: فقط فایل‌های نهایی (بدون سورس)

اگه نمی‌خوای Node.js یا سورس روی سیستم هدف باشه، می‌تونی فقط خروجی build رو کپی کنی.

### مراحل

1. روی **سیستم توسعه‌دهنده** (همین سیستم):
   ```bash
   cd nimbalyst-rtl-support
   npm run build
   ```

2. یه پوشه با این ساختار بساز:
   ```
   nimbalyst-rtl-support/
   ├── manifest.json
   ├── dist/
   │   ├── index.js
   │   └── index.css
   ```
   (فقط `manifest.json` و `dist/` لازمه)

3. این پوشه رو به مسیر extensions سیستم هدف کپی کن (مثل روش ۲، مرحله ۳).

4. **Nimbalyst رو restart کن.**

> ⚠️ **نکته**: روش ۳ مزیتش اینه که Node.js لازم نداره، ولی باگ‌fix یا آپدیت سخت‌تره. برای توزیع بین کاربران عادی مناسب‌تره.

---

## ✅ تایید نصب

بعد از نصب، مطمئن شو کار می‌کنه:

1. Nimbalyst رو باز کن.
2. یه session agent باز کن.
3. این پیام رو بفرست: *"سلام، یه متن فارسی بنویس"*
4. پاسخ agent باید **راست‌چین (RTL)** باشه — متن از راست به چپ و راست‌چین.

**بررسی فنی** (اختیاری): در DevTools console (`Ctrl+Shift+I`) این رو اجرا کن:
```javascript
typeof window.nimbalystRtlSupport
// باید "object" برگردانه
```

---

## 🔄 آپدیت کردن

| روش نصب | آپدیت |
|---------|-------|
| روش ۱ (devInstall) | سورس رو جایگزین کن، بعد `extension_reload(extensionId, path)` |
| روش ۲ (دستی) | `npm run build` دوباره، بعد `dist/` رو جایگزین کن، Nimbalyst restart |
| روش ۳ (نهایی) | `dist/` جدید رو جایگزین کن، Nimbalyst restart |

---

## ❌ مشکل‌یابی

**Extension لود نمی‌شه:**
- مطمئن شو مسیر درسته (`%APPDATA%\@nimbalyst\electron\extensions\` روی Windows)
- Nimbalyst رو restart کن (extension‌ها فقط در startup کشف می‌شن)
- Console DevTools رو چک کن برای خطا

**RTL اعمال نمی‌شه:**
- `typeof window.nimbalystRtlSupport` رو چک کن — اگه `undefined` بود، extension فعال نشده
- مطمئن شو `rtlSupport.enabled` در تنظیمات `true` هست
- Extension DevTools رو فعال کن و لاگ‌ها رو ببین (`get_logs`)

**می‌خوای غیرفعال کنی:**
- `window.nimbalystRtlSupport.disable()` در console
- یا پوشه extension رو از مسیر extensions حذف کن و restart کن
