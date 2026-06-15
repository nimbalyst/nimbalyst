/**
 * RTL Detection — متن پردازش و جهت غالب رو تشخیص میده.
 *
 * الگوریتم:
 *  - کاراکترهای حرفی/عددی رو می‌شماره
 *  - تعداد کاراکترهای RTL رو با محدوده‌های Unicode RTL مقایسه می‌کنه
 *  - اگه نسبت RTL ≥ threshold باشه → 'rtl'، وگرنه 'ltr'
 *
 * گرانولاریتی: per-block (هر بلاک متن جداگانه بررسی می‌شه)
 */

/** محدوده‌های Unicode برای اسکریپت‌های راست‌به‌چپ */
const RTL_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0590, 0x05ff], // Hebrew
  [0x0600, 0x06ff], // Arabic
  [0x0700, 0x074f], // Syriac
  [0x0750, 0x077f], // Arabic Supplement
  [0x0780, 0x07bf], // Thaana
  [0x07c0, 0x07ff], // NKo
  [0x0800, 0x083f], // Samaritan
  [0x0840, 0x085f], // Mandaic
  [0x08a0, 0x08ff], // Arabic Extended-A
  [0xfb1d, 0xfb4f], // Hebrew Presentation Forms
  [0xfb50, 0xfdff], // Arabic Presentation Forms-A
  [0xfe70, 0xfeff], // Arabic Presentation Forms-B
];

const LTR_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0041, 0x005a], // Basic Latin uppercase
  [0x0061, 0x007a], // Basic Latin lowercase
  [0x00c0, 0x024f], // Latin Extended
];

/** تست اینکه آیا code point به اسکریپت RTL تعلق داره یا نه */
function isRtlChar(code: number): boolean {
  for (const [start, end] of RTL_RANGES) {
    if (code >= start && code <= end) return true;
  }
  return false;
}

/** تست اینکه آیا code point یک کاراکتر حرفی/عددی معنادار هست */
function isMeaningfulChar(char: string): boolean {
  // حروف و اعداد از هر اسکریپتی (شامل Latin, Arabic, Persian, Hebrew و...)
  // \p{L} = هر حرف، \p{N} = هر عدد
  return /[\p{L}\p{N}]/u.test(char);
}

/**
 * جهت غالب یک متن رو تشخیص میده.
 *
 * @param text متن ورودی (می‌تونه چندخطی باشه)
 * @param threshold حداقل نسبت RTL برای تشخیص RTL (پیش‌فرض 0.3 = ۳۰٪)
 * @returns 'rtl' یا 'ltr'
 */
export function detectDirection(
  text: string,
  threshold: number = 0.3
): 'rtl' | 'ltr' {
  if (!text || !text.trim()) return 'ltr';

  let rtlCount = 0;
  let totalCount = 0;

  for (const char of text) {
    if (!isMeaningfulChar(char)) continue;

    totalCount++;
    const code = char.codePointAt(0);
    if (code !== undefined && isRtlChar(code)) {
      rtlCount++;
    }
  }

  if (totalCount === 0) return 'ltr';
  return rtlCount / totalCount >= threshold ? 'rtl' : 'ltr';
}

/**
 * جهت رو برای بلاک‌های جداگانه متن تشخیص میده (per-block).
 * متن رو با خطوط خالی به بلاک‌ها تقسیم می‌کنه و هر بلاک رو جدا بررسی می‌کنه.
 *
 * @returns آرایه‌ای از { text, direction }
 */
export function detectBlocks(
  text: string,
  threshold: number = 0.3
): Array<{ text: string; direction: 'rtl' | 'ltr' }> {
  if (!text) return [];

  // تقسیم با خطوط خالی (یعنی پاراگراف‌ها)
  const blocks = text.split(/\n\s*\n/);
  return blocks.map((block) => ({
    text: block,
    direction: detectDirection(block, threshold),
  }));
}

/**
 * جهت کلی یک پیام رو تشخیص میده — برای تصمیم‌گیری جهت پیش‌فرض کل پیام.
 * از روی غالب بلاک‌ها تصمیم می‌گیره.
 */
export function detectMessageDirection(
  text: string,
  threshold: number = 0.3
): 'rtl' | 'ltr' {
  if (!text || !text.trim()) return 'ltr';

  const blocks = detectBlocks(text, threshold);
  const rtlBlocks = blocks.filter((b) => b.direction === 'rtl').length;
  const ltrBlocks = blocks.length - rtlBlocks;

  // اکثریت بلاک‌ها تصمیم می‌گیرن؛ تساوی → LTR
  return rtlBlocks > ltrBlocks ? 'rtl' : 'ltr';
}

/**
 * یه متن رو به run‌های هم‌جهت تقسیم می‌کنه (برای inline RTL).
 * مثلاً "Hello سلام world" → [{Hello, ltr}, {سلام, rtl}, {world, ltr}]
 *
 * این برای رندر inline استفاده می‌شه تا هر قطعه RTL با isolate به‌درستی نمایش داده بشه.
 *
 * @returns آرایه‌ای از { text, direction, isRtl }
 */
export function detectInlineRuns(
  text: string,
  threshold: number = 0.3
): Array<{ text: string; direction: 'rtl' | 'ltr' }> {
  if (!text) return [];

  const result: Array<{ text: string; direction: 'rtl' | 'ltr' }> = [];
  // تقسیم با فواصل (space, tab) ولی حفظ delimiter
  // استراتژی: کاراکتر به کاراکتر، جهت هر کاراکتر رو تعیین، run‌های هم‌جهت رو گروه کن
  let currentRun = '';
  let currentDir: 'rtl' | 'ltr' | 'neutral' = 'neutral';

  const flush = (dir: 'rtl' | 'ltr') => {
    if (currentRun) {
      result.push({ text: currentRun, direction: dir });
      currentRun = '';
    }
  };

  for (const char of text) {
    // فاصله و علائم نگارشی = neutral (به run فعلی اضافه می‌شن)
    const code = char.codePointAt(0);
    const isMeaningful = code !== undefined && /[\p{L}\p{N}]/u.test(char);

    if (!isMeaningful) {
      // neutral char — به run فعلی اضافه کن
      currentRun += char;
      continue;
    }

    const isRtl = code !== undefined && isRtlChar(code);
    const charDir: 'rtl' | 'ltr' = isRtl ? 'rtl' : 'ltr';

    if (currentDir === 'neutral') {
      currentDir = charDir;
      currentRun += char;
    } else if (currentDir === charDir) {
      currentRun += char;
    } else {
      // تغییر جهت — flush قبلی
      flush(currentDir as 'rtl' | 'ltr');
      currentDir = charDir;
      currentRun = char;
    }
  }

  // flush آخرین run
  if (currentDir !== 'neutral') {
    flush(currentDir as 'rtl' | 'ltr');
  } else if (currentRun) {
    // فقط neutral (مثلاً فقط فاصله) — به‌عنوان ltr
    result.push({ text: currentRun, direction: 'ltr' });
  }

  // اگه تنظیمات inline فعال نیست، همه‌رو به‌عنوان جهت کلی برگردون
  // (این تابع فقط برای inline استفاده می‌شه، پس threshold رو اینجا اعمال نمی‌کنیم)
  void threshold;

  // ادغام run‌های RTL کوچک مجاور با neutral
  return mergeNeutralRuns(result);
}

/** neutral run‌های بین دو run هم‌جهت رو با اون direction ادغام کن */
function mergeNeutralRuns(
  runs: Array<{ text: string; direction: 'rtl' | 'ltr' }>
): Array<{ text: string; direction: 'rtl' | 'ltr' }> {
  if (runs.length <= 1) return runs;
  const merged: Array<{ text: string; direction: 'rtl' | 'ltr' }> = [runs[0]];
  for (let i = 1; i < runs.length; i++) {
    const last = merged[merged.length - 1];
    if (last.direction === runs[i].direction) {
      last.text += runs[i].text;
    } else {
      merged.push(runs[i]);
    }
  }
  return merged;
}
