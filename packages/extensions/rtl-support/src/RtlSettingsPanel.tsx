/**
 * RtlSettingsPanel — the extension settings panel inside Nimbalyst Settings.
 *
 * Lets users configure RTL settings without editing JSON:
 *  - enabled (toggle)
 *  - mode (auto/rtl/ltr)
 *  - threshold (slider)
 *  - perBlock (toggle)
 *  - inputRtl (toggle)
 *  - inlineDetect (toggle)
 *  - debug (toggle)
 *  - reset button
 */

import { useState, useEffect, type CSSProperties } from 'react';
import { loadSettings, saveSettings, resetSettings, type RtlSettings, type RtlMode } from './settings';
import { setDebug } from './debug';

type RtlSettingsPanelProps = {
  theme?: string;
};

export function RtlSettingsPanel({ theme }: RtlSettingsPanelProps) {
  const [settings, setSettings] = useState<RtlSettings>(loadSettings());

  useEffect(() => {
    // theme can be used for future styling refinements
    void theme;
  }, [theme]);

  const isDark = theme === 'dark';

  const update = (patch: Partial<RtlSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    saveSettings(next);
    setDebug(next.debug);
    // Notify the runtime API
    const api = (globalThis as Record<string, unknown>).nimbalystRtlSupport as {
      updateSettings?: (s: Partial<RtlSettings>) => void;
    } | undefined;
    api?.updateSettings?.(next);
  };

  const onReset = () => {
    const defaults = resetSettings();
    setSettings(defaults);
    setDebug(defaults.debug);
  };

  const c = colors(isDark);

  return (
    <div style={containerStyle(c)}>
      <h2 style={headingStyle(c)}>RTL Support</h2>
      <p style={descStyle(c)}>
        Automatic right-to-left text direction detection for agent transcripts and markdown content.
        Changes apply immediately.
      </p>

      <Toggle
        label="Enable RTL Support"
        desc="Master on/off switch for the extension"
        checked={settings.enabled}
        onChange={(v) => update({ enabled: v })}
        colors={c}
      />

      <Divider colors={c} />

      <Field label="Mode" desc="auto = detect per block, rtl/ltr = force a direction" colors={c}>
        <SegmentedControl
          value={settings.mode}
          options={[
            { value: 'auto', label: 'Auto' },
            { value: 'rtl', label: 'RTL' },
            { value: 'ltr', label: 'LTR' },
          ]}
          onChange={(v) => update({ mode: v as RtlMode })}
          colors={c}
        />
      </Field>

      <Divider colors={c} />

      <Field
        label={'RTL threshold: ' + Math.round(settings.threshold * 100) + '%'}
        desc="Minimum ratio of RTL characters to classify a block as RTL"
        colors={c}
      >
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={settings.threshold}
          onChange={(e) => update({ threshold: parseFloat(e.target.value) })}
          style={{ width: '100%' }}
        />
      </Field>

      <Divider colors={c} />

      <Toggle
        label="Per-block detection"
        desc="Analyze each text block independently (recommended for mixed messages)"
        checked={settings.perBlock}
        onChange={(v) => update({ perBlock: v })}
        colors={c}
      />

      <Toggle
        label="RTL on input fields"
        desc="Switch input direction to RTL when typing RTL languages"
        checked={settings.inputRtl}
        onChange={(v) => update({ inputRtl: v })}
        colors={c}
      />

      <Toggle
        label="Inline detection"
        desc="Isolate RTL runs within LTR paragraphs for correct bidi rendering"
        checked={settings.inlineDetect}
        onChange={(v) => update({ inlineDetect: v })}
        colors={c}
      />

      <Toggle
        label="Debug logging"
        desc="Enable detection logs in the console (for troubleshooting)"
        checked={settings.debug}
        onChange={(v) => update({ debug: v })}
        colors={c}
      />

      <Divider colors={c} />

      <div style={{ display: 'flex', gap: '8px', marginTop: '16px' }}>
        <button style={buttonStyle(c)} onClick={onReset}>
          Reset to defaults
        </button>
      </div>

      <p style={{ ...descStyle(c), marginTop: '16px', fontSize: '12px' }}>
        Shortcut: <kbd style={kbdStyle(c)}>Ctrl+Shift+R</kbd> to toggle quickly
      </p>
    </div>
  );
}

// ===== Styling helpers =====

interface ColorSet {
  bg: string;
  surface: string;
  border: string;
  text: string;
  textMuted: string;
  accent: string;
  accentText: string;
}

function colors(isDark: boolean): ColorSet {
  if (isDark) {
    return {
      bg: '#1a1a1a',
      surface: '#2a2a2a',
      border: '#3a3a3a',
      text: '#e4e4e4',
      textMuted: '#999',
      accent: '#3b82f6',
      accentText: '#fff',
    };
  }
  return {
    bg: '#ffffff',
    surface: '#f5f5f5',
    border: '#e0e0e0',
    text: '#1a1a1a',
    textMuted: '#666',
    accent: '#3b82f6',
    accentText: '#fff',
  };
}

const containerStyle = (c: ColorSet): CSSProperties => ({
  padding: '20px',
  color: c.text,
  fontFamily: 'system-ui, sans-serif',
  maxWidth: '600px',
});

const headingStyle = (c: ColorSet): CSSProperties => ({
  margin: '0 0 4px 0',
  fontSize: '18px',
  fontWeight: 600,
  color: c.text,
});

const descStyle = (c: ColorSet): CSSProperties => ({
  margin: '0 0 16px 0',
  fontSize: '13px',
  color: c.textMuted,
  lineHeight: 1.5,
});

const buttonStyle = (c: ColorSet): CSSProperties => ({
  padding: '8px 16px',
  backgroundColor: c.surface,
  color: c.text,
  border: '1px solid ' + c.border,
  borderRadius: '6px',
  cursor: 'pointer',
  fontSize: '13px',
});

const kbdStyle = (c: ColorSet): CSSProperties => ({
  padding: '2px 6px',
  backgroundColor: c.surface,
  border: '1px solid ' + c.border,
  borderRadius: '4px',
  fontSize: '11px',
  fontFamily: 'monospace',
});

// ===== Sub-components =====

function Field({
  label,
  desc,
  children,
  colors: c,
}: {
  label: string;
  desc?: string;
  children: React.ReactNode;
  colors: ColorSet;
}) {
  return (
    <div style={{ marginBottom: '16px' }}>
      <div style={{ fontSize: '13px', fontWeight: 500, color: c.text, marginBottom: '4px' }}>{label}</div>
      {desc && <div style={{ fontSize: '12px', color: c.textMuted, marginBottom: '8px' }}>{desc}</div>}
      {children}
    </div>
  );
}

function Toggle({
  label,
  desc,
  checked,
  onChange,
  colors: c,
}: {
  label: string;
  desc?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  colors: ColorSet;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '16px', gap: '12px' }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: '13px', fontWeight: 500, color: c.text }}>{label}</div>
        {desc && <div style={{ fontSize: '12px', color: c.textMuted, marginTop: '2px' }}>{desc}</div>}
      </div>
      <button
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        style={{
          flexShrink: 0,
          width: '40px',
          height: '22px',
          borderRadius: '11px',
          border: 'none',
          backgroundColor: checked ? c.accent : c.border,
          cursor: 'pointer',
          position: 'relative',
          transition: 'background-color 0.2s',
        }}
      >
        <span
          style={{
            position: 'absolute',
            top: '2px',
            left: checked ? '20px' : '2px',
            width: '18px',
            height: '18px',
            borderRadius: '50%',
            backgroundColor: '#fff',
            transition: 'left 0.2s',
          }}
        />
      </button>
    </div>
  );
}

function SegmentedControl({
  value,
  options,
  onChange,
  colors: c,
}: {
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (v: string) => void;
  colors: ColorSet;
}) {
  return (
    <div style={{ display: 'flex', gap: '4px', backgroundColor: c.surface, padding: '3px', borderRadius: '6px', border: '1px solid ' + c.border }}>
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          style={{
            flex: 1,
            padding: '6px 12px',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            fontSize: '12px',
            fontWeight: value === opt.value ? 600 : 400,
            backgroundColor: value === opt.value ? c.accent : 'transparent',
            color: value === opt.value ? c.accentText : c.text,
            transition: 'all 0.15s',
          }}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function Divider({ colors: c }: { colors: ColorSet }) {
  return <div style={{ height: '1px', backgroundColor: c.border, margin: '12px 0' }} />;
}
