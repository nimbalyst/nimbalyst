/**
 * PropertyPanel - Element property editor sidebar
 *
 * When an element is selected in the mockup iframe, shows editable
 * CSS properties and component attributes. Changes are applied back
 * to the element's inline styles in real-time.
 */

import { useState, useEffect, useCallback, memo } from 'react';
import { extractProperties, EDITABLE_CSS_PROPERTIES, type ExtractedProperties } from '../utils/cssPropertyExtractor';

interface PropertyPanelProps {
  /** The selected element in the iframe DOM */
  selectedElement: Element | null;
  /** Callback when a property is changed (for dirty tracking) */
  onPropertyChange?: () => void;
}

export const PropertyPanel = memo(function PropertyPanel({
  selectedElement,
  onPropertyChange,
}: PropertyPanelProps) {
  const [props, setProps] = useState<ExtractedProperties | null>(null);

  // Extract properties when selection changes
  useEffect(() => {
    if (!selectedElement) {
      setProps(null);
      return;
    }
    setProps(extractProperties(selectedElement));
  }, [selectedElement]);

  // Apply a CSS property change to the element
  const handleCssChange = useCallback(
    (key: string, value: string) => {
      if (!selectedElement) return;
      const el = selectedElement as HTMLElement;
      (el.style as any)[key] = value;

      // Update local state
      setProps(extractProperties(selectedElement));
      onPropertyChange?.();
    },
    [selectedElement, onPropertyChange]
  );

  // Apply a component attribute change
  const handleAttrChange = useCallback(
    (attr: string, value: string) => {
      if (!selectedElement) return;
      selectedElement.setAttribute(attr, value);

      // Force re-render for web components
      if (selectedElement.tagName.toLowerCase().startsWith('nim-')) {
        const component = selectedElement as any;
        if (typeof component.render === 'function') {
          component.render();
        }
      }

      setProps(extractProperties(selectedElement));
      onPropertyChange?.();
    },
    [selectedElement, onPropertyChange]
  );

  // Apply text content change
  const handleTextChange = useCallback(
    (text: string) => {
      if (!selectedElement) return;
      // Only update direct text, not child elements
      const el = selectedElement as HTMLElement;
      if (el.children.length === 0) {
        el.textContent = text;
      }
      setProps(extractProperties(selectedElement));
      onPropertyChange?.();
    },
    [selectedElement, onPropertyChange]
  );

  if (!props) {
    return (
      <div style={{
        padding: 16,
        color: '#808080',
        fontSize: 12,
        textAlign: 'center',
      }}>
        Select an element to edit its properties
      </div>
    );
  }

  return (
    <div style={{
      padding: 8,
      overflowY: 'auto',
      fontSize: 12,
      color: 'var(--nim-text, #e5e5e5)',
    }}>
      {/* Element info */}
      <div style={{
        padding: '6px 8px',
        marginBottom: 8,
        background: 'var(--nim-bg-tertiary, #3a3a3a)',
        borderRadius: 4,
        fontSize: 11,
        fontFamily: 'monospace',
        color: 'var(--nim-text-muted, #b3b3b3)',
      }}>
        &lt;{props.tagName}&gt;
      </div>

      {/* Text content */}
      {props.textContent && (
        <FieldGroup label="Text">
          <input
            type="text"
            value={props.textContent}
            onChange={(e) => handleTextChange(e.target.value)}
            style={inputStyle}
          />
        </FieldGroup>
      )}

      {/* Component attributes */}
      {Object.keys(props.componentAttrs).length > 0 && (
        <>
          <SectionHeader>Component</SectionHeader>
          {Object.entries(props.componentAttrs).map(([attr, value]) => (
            <FieldGroup key={attr} label={attr}>
              <input
                type="text"
                value={value}
                onChange={(e) => handleAttrChange(attr, e.target.value)}
                style={inputStyle}
              />
            </FieldGroup>
          ))}
        </>
      )}

      {/* CSS properties */}
      <SectionHeader>Style</SectionHeader>
      {EDITABLE_CSS_PROPERTIES.map((prop) => {
        const value = (props as any)[prop.key] || '';
        return (
          <FieldGroup key={prop.key} label={prop.label}>
            {prop.type === 'color' ? (
              <div style={{ display: 'flex', gap: 4 }}>
                <input
                  type="color"
                  value={rgbToHex(value)}
                  onChange={(e) => handleCssChange(prop.key, e.target.value)}
                  style={{ width: 24, height: 24, border: 'none', cursor: 'pointer', padding: 0 }}
                />
                <input
                  type="text"
                  value={value}
                  onChange={(e) => handleCssChange(prop.key, e.target.value)}
                  style={{ ...inputStyle, flex: 1 }}
                />
              </div>
            ) : prop.type === 'select' ? (
              <select
                value={value}
                onChange={(e) => handleCssChange(prop.key, e.target.value)}
                style={inputStyle}
              >
                {prop.options.map((opt) => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={value}
                onChange={(e) => handleCssChange(prop.key, e.target.value)}
                style={inputStyle}
              />
            )}
          </FieldGroup>
        );
      })}

      {/* Layout */}
      {(props.display === 'flex' || props.display === 'inline-flex') && (
        <>
          <SectionHeader>Layout</SectionHeader>
          <FieldGroup label="Direction">
            <select
              value={props.flexDirection}
              onChange={(e) => handleCssChange('flexDirection', e.target.value)}
              style={inputStyle}
            >
              <option value="row">Row</option>
              <option value="column">Column</option>
              <option value="row-reverse">Row Reverse</option>
              <option value="column-reverse">Column Reverse</option>
            </select>
          </FieldGroup>
          <FieldGroup label="Align">
            <select
              value={props.alignItems}
              onChange={(e) => handleCssChange('alignItems', e.target.value)}
              style={inputStyle}
            >
              <option value="stretch">Stretch</option>
              <option value="flex-start">Start</option>
              <option value="center">Center</option>
              <option value="flex-end">End</option>
            </select>
          </FieldGroup>
          <FieldGroup label="Justify">
            <select
              value={props.justifyContent}
              onChange={(e) => handleCssChange('justifyContent', e.target.value)}
              style={inputStyle}
            >
              <option value="flex-start">Start</option>
              <option value="center">Center</option>
              <option value="flex-end">End</option>
              <option value="space-between">Space Between</option>
              <option value="space-around">Space Around</option>
            </select>
          </FieldGroup>
        </>
      )}

      {/* Dimensions */}
      <SectionHeader>Size</SectionHeader>
      <FieldGroup label="Width">
        <input type="text" value={props.width} onChange={(e) => handleCssChange('width', e.target.value)} style={inputStyle} />
      </FieldGroup>
      <FieldGroup label="Height">
        <input type="text" value={props.height} onChange={(e) => handleCssChange('height', e.target.value)} style={inputStyle} />
      </FieldGroup>
    </div>
  );
});

// Helper components
function FieldGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
      <label style={{ width: 70, fontSize: 11, color: 'var(--nim-text-muted, #b3b3b3)', flexShrink: 0 }}>
        {label}
      </label>
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: 10,
      fontWeight: 600,
      textTransform: 'uppercase' as const,
      letterSpacing: '0.05em',
      color: 'var(--nim-text-faint, #808080)',
      marginTop: 12,
      marginBottom: 6,
      paddingBottom: 4,
      borderBottom: '1px solid var(--nim-border-subtle, #3a3a3a)',
    }}>
      {children}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '4px 6px',
  fontSize: 11,
  fontFamily: 'monospace',
  color: 'var(--nim-text, #e5e5e5)',
  background: 'var(--nim-bg, #2d2d2d)',
  border: '1px solid var(--nim-border, #4a4a4a)',
  borderRadius: 3,
  outline: 'none',
  boxSizing: 'border-box' as const,
};

// Convert rgb(r, g, b) to hex for color picker
function rgbToHex(rgb: string): string {
  const match = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!match) return '#000000';
  const r = parseInt(match[1]).toString(16).padStart(2, '0');
  const g = parseInt(match[2]).toString(16).padStart(2, '0');
  const b = parseInt(match[3]).toString(16).padStart(2, '0');
  return `#${r}${g}${b}`;
}
