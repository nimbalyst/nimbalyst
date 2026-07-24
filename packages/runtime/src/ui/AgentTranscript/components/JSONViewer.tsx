import type { JSX } from 'react';
import React, { useEffect } from 'react';

// Inject JSON viewer styles once (for theme-specific syntax highlighting)
const injectJSONViewerStyles = () => {
  const styleId = 'json-viewer-styles';
  if (document.getElementById(styleId)) return;

  const style = document.createElement('style');
  style.id = styleId;
  style.textContent = `
    /* Light theme (default) */
    .json-key { color: #0451A5; font-weight: 500; }
    .json-string { color: #A31515; }
    .json-number { color: #098658; }
    .json-boolean { color: #0000FF; font-weight: 600; }
    .json-null { color: #0000FF; font-weight: 600; font-style: italic; }

    /* Dark and Crystal Dark themes */
    .dark-theme .json-key,
    .crystal-dark-theme .json-key { color: #9CDCFE; }
    .dark-theme .json-string,
    .crystal-dark-theme .json-string { color: #CE9178; }
    .dark-theme .json-number,
    .crystal-dark-theme .json-number { color: #B5CEA8; }
    .dark-theme .json-boolean,
    .crystal-dark-theme .json-boolean { color: #569CD6; }
    .dark-theme .json-null,
    .crystal-dark-theme .json-null { color: #569CD6; }
  `;
  document.head.appendChild(style);
};

interface JSONViewerProps {
  data: any;
  maxHeight?: string;
}

export const JSONViewer: React.FC<JSONViewerProps> = ({ data, maxHeight = '16rem' }) => {
  // Inject styles on mount
  useEffect(() => {
    injectJSONViewerStyles();
  }, []);

  const formatJSON = (obj: any): JSX.Element => {
    let keyCounter = 0;
    const getUniqueKey = (prefix: string) => `${prefix}-${keyCounter++}`;

    const renderValue = (value: any, indent: number = 0): JSX.Element[] => {
      const indentStr = '  '.repeat(indent);
      const elements: JSX.Element[] = [];

      if (value === null) {
        elements.push(<span key={getUniqueKey('null')} className="json-null">null</span>);
      } else if (typeof value === 'boolean') {
        elements.push(<span key={getUniqueKey('bool')} className="json-boolean font-semibold">{String(value)}</span>);
      } else if (typeof value === 'number') {
        elements.push(<span key={getUniqueKey('num')} className="json-number">{value}</span>);
      } else if (typeof value === 'string') {
        elements.push(<span key={getUniqueKey('str')} className="json-string">"{value}"</span>);
      } else if (Array.isArray(value)) {
        if (value.length === 0) {
          elements.push(<span key={getUniqueKey('arr')}>[]</span>);
        } else {
          elements.push(<span key={getUniqueKey('arr-open')} className="json-bracket text-[var(--nim-text-muted)] font-semibold">[</span>);
          elements.push(<br key={getUniqueKey('br')} />);
          value.forEach((item, idx) => {
            elements.push(<span key={getUniqueKey('indent')}>{indentStr}  </span>);
            elements.push(...renderValue(item, indent + 1));
            if (idx < value.length - 1) {
              elements.push(<span key={getUniqueKey('comma')} className="json-punctuation text-[var(--nim-text-faint)]">,</span>);
            }
            elements.push(<br key={getUniqueKey('br')} />);
          });
          elements.push(<span key={getUniqueKey('indent')}>{indentStr}</span>);
          elements.push(<span key={getUniqueKey('arr-close')} className="json-bracket text-[var(--nim-text-muted)] font-semibold">]</span>);
        }
      } else if (typeof value === 'object') {
        const keys = Object.keys(value);
        if (keys.length === 0) {
          elements.push(<span key={getUniqueKey('obj')}>{'{}'}</span>);
        } else {
          elements.push(<span key={getUniqueKey('obj-open')} className="json-bracket text-[var(--nim-text-muted)] font-semibold">{'{'}</span>);
          elements.push(<br key={getUniqueKey('br')} />);
          keys.forEach((key, idx) => {
            elements.push(<span key={getUniqueKey('indent')}>{indentStr}  </span>);
            elements.push(<span key={getUniqueKey('key')} className="json-key">"{key}"</span>);
            elements.push(<span key={getUniqueKey('colon')} className="json-punctuation text-[var(--nim-text-faint)]">: </span>);
            elements.push(...renderValue(value[key], indent + 1));
            if (idx < keys.length - 1) {
              elements.push(<span key={getUniqueKey('comma')} className="json-punctuation text-[var(--nim-text-faint)]">,</span>);
            }
            elements.push(<br key={getUniqueKey('br')} />);
          });
          elements.push(<span key={getUniqueKey('indent')}>{indentStr}</span>);
          elements.push(<span key={getUniqueKey('obj-close')} className="json-bracket text-[var(--nim-text-muted)] font-semibold">{'}'}</span>);
        }
      }

      return elements;
    };

    return <>{renderValue(obj)}</>;
  };

  return (
    <pre
      className="json-viewer font-mono text-xs leading-normal text-[var(--nim-text)] bg-[var(--nim-bg-secondary)] p-3 rounded-md overflow-x-auto m-0 whitespace-pre"
      style={{ maxHeight, overflowY: 'auto' }}
    >
      {formatJSON(data)}
    </pre>
  );
};
