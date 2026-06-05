import React, { useState, useEffect, useCallback } from 'react';
import QRCode from 'qrcode';
import { copyToClipboard } from '@nimbalyst/runtime';

interface QRPairingModalProps {
  isOpen: boolean;
  onClose: () => void;
  serverUrl: string;
  /** Current sleep prevention mode */
  preventSleepMode?: 'off' | 'always' | 'pluggedIn';
  /** Called when the user changes the prevent-sleep mode */
  onPreventSleepModeChange?: (mode: 'off' | 'always' | 'pluggedIn') => void;
}

/**
 * Check if the URL is a localhost/local dev server URL
 */
function isLocalDevServer(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0';
  } catch {
    return false;
  }
}

/**
 * Replace localhost in URL with the given IP address
 */
function replaceLocalhostWithIP(url: string, ip: string): string {
  try {
    const parsed = new URL(url);
    parsed.hostname = ip;
    return parsed.toString().replace(/\/$/, ''); // Remove trailing slash
  } catch {
    return url;
  }
}

/**
 * QR Pairing Modal
 *
 * Shows a QR code containing the encryption key seed for pairing with mobile devices.
 * Mobile devices authenticate independently via Stytch OAuth - the QR code only shares
 * the encryption key needed for E2E encrypted sync.
 */
export function QRPairingModal({ isOpen, onClose, serverUrl, preventSleepMode, onPreventSleepModeChange }: QRPairingModalProps) {
  const [qrDataUrl, setQRDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [qrPayload, setQRPayload] = useState<object | null>(null);
  const [copied, setCopied] = useState(false);

  // Local dev server detection
  const [localIP, setLocalIP] = useState<string | null>(null);
  const [useLocalIP, setUseLocalIP] = useState(true); // Default to using LAN IP for local servers
  const [effectiveUrl, setEffectiveUrl] = useState(serverUrl);

  const isLocalServer = isLocalDevServer(serverUrl);

  // Fetch local IP when modal opens
  useEffect(() => {
    if (isOpen && isLocalServer) {
      window.electronAPI.network.getLocalIP().then((ip: string | null) => {
        setLocalIP(ip);
      });
    }
  }, [isOpen, isLocalServer]);

  // Update effective URL when toggle changes or local IP is fetched
  useEffect(() => {
    if (isLocalServer && localIP && useLocalIP) {
      setEffectiveUrl(replaceLocalhostWithIP(serverUrl, localIP));
    } else {
      setEffectiveUrl(serverUrl);
    }
  }, [isLocalServer, localIP, useLocalIP, serverUrl]);

  const generateQR = useCallback(async () => {
    if (!effectiveUrl) {
      setError('Server URL is required');
      return;
    }

    try {
      // Get QR payload from main process (with effective URL)
      // The payload contains only serverUrl and encryptionKeySeed
      // Mobile devices authenticate independently via Stytch OAuth
      const payload = await window.electronAPI.credentials.generateQRPayload(effectiveUrl);
      setQRPayload(payload);

      // Wrap payload in a nimbalyst:// deep link URL so the iOS Camera app
      // can open Nimbalyst directly when scanning. The payload stays local —
      // it goes from screen -> camera -> app, never touches a server.
      const payloadBase64 = btoa(JSON.stringify(payload));
      const deepLinkUrl = `nimbalyst://pair?data=${encodeURIComponent(payloadBase64)}`;

      // Generate QR code data URL
      const dataUrl = await QRCode.toDataURL(deepLinkUrl, {
        width: 280,
        margin: 2,
        color: {
          dark: '#000000',
          light: '#ffffff',
        },
        errorCorrectionLevel: 'M',
      });

      setQRDataUrl(dataUrl);
      setError(null);
      setCopied(false);
    } catch (err) {
      console.error('[QRPairingModal] Failed to generate QR:', err);
      setError(err instanceof Error ? err.message : 'Failed to generate QR code');
    }
  }, [effectiveUrl]);

  const handleCopyPayload = async () => {
    if (!qrPayload) return;
    try {
      const jsonString = JSON.stringify(qrPayload, null, 2);
      console.log('[QRPairingModal] Copying payload:', jsonString);
      await copyToClipboard(jsonString);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('[QRPairingModal] Failed to copy:', err);
    }
  };

  // Generate QR when modal opens or effective URL changes
  useEffect(() => {
    if (isOpen && effectiveUrl) {
      generateQR();
    }
  }, [isOpen, effectiveUrl, generateQR]);

  // Clear state when modal closes
  useEffect(() => {
    if (!isOpen) {
      setQRDataUrl(null);
      setError(null);
      setQRPayload(null);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div
      className="qr-modal-overlay fixed inset-0 bg-black/50 flex items-center justify-center z-[10000] overflow-y-auto py-4"
      onClick={onClose}
    >
      <div
        className="qr-modal-content bg-nim rounded-xl w-[400px] max-h-[90vh] overflow-y-auto shadow-2xl my-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="qr-modal-header flex items-center justify-between px-5 py-4 border-b border-nim sticky top-0 bg-nim z-10">
          <h2 className="qr-modal-title text-lg font-semibold text-nim m-0">Pair Mobile Device</h2>
          <button
            className="qr-modal-close p-1 bg-transparent border-none cursor-pointer text-nim-muted hover:text-nim"
            onClick={onClose}
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M15 5L5 15M5 5l10 10" />
            </svg>
          </button>
        </div>

        <div className="qr-modal-body p-5">
          {/* Local dev server notice */}
          {isLocalServer && localIP && (
            <div className="qr-dev-notice mb-4 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
              <div className="qr-dev-notice-header flex items-center gap-2 text-amber-500 font-medium text-sm mb-2">
                <svg className="qr-dev-notice-icon" width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M8 1a7 7 0 100 14A7 7 0 008 1zM7 5a1 1 0 112 0v3a1 1 0 11-2 0V5zm1 7a1 1 0 100-2 1 1 0 000 2z" />
                </svg>
                <span>Local Development Server</span>
              </div>
              <p className="qr-dev-notice-text text-xs text-nim-muted mb-2">
                Your phone needs to connect via your local network IP instead of localhost.
              </p>
              <label className="qr-dev-toggle flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={useLocalIP}
                  onChange={(e) => setUseLocalIP(e.target.checked)}
                />
                <span className="qr-dev-toggle-text text-xs text-nim">
                  Use LAN IP: <code className="bg-nim-secondary px-1 py-0.5 rounded">{localIP}</code>
                </span>
              </label>
              <p className="qr-dev-notice-url text-xs text-nim-faint mt-2 mb-0">
                Server URL in QR: <code className="bg-nim-secondary px-1 py-0.5 rounded">{effectiveUrl}</code>
              </p>
            </div>
          )}

          {error ? (
            <div className="qr-error text-center py-8">
              <p className="text-nim-error mb-4">{error}</p>
              <button
                className="qr-regenerate-button px-4 py-2 bg-nim-primary text-nim-on-primary rounded-md text-sm font-medium cursor-pointer hover:bg-nim-primary-hover"
                onClick={generateQR}
              >
                Try Again
              </button>
            </div>
          ) : qrDataUrl ? (
            <>
              <div className="qr-code-container flex justify-center mb-4">
                <img
                  src={qrDataUrl}
                  alt="QR Code for mobile pairing"
                  className="qr-code-image rounded-lg cursor-pointer"
                  onClick={(e) => {
                    if (e.metaKey && qrPayload) {
                      handleCopyPayload();
                    }
                  }}
                  title="Cmd+click to copy payload"
                />
              </div>

              <div className="qr-instructions text-sm text-nim-muted space-y-1 mb-4">
                <p className="qr-step">1. Open Nimbalyst on your mobile device</p>
                <p className="qr-step">2. Go to Settings and tap "Scan QR Code"</p>
                <p className="qr-step">3. Point your camera at this QR code</p>
                <p className="qr-step">4. Sign in with the same account as desktop</p>
              </div>

              <div className="qr-info mt-3 p-3 bg-green-500/10 border border-green-500/20 rounded-lg text-[13px] text-nim-muted">
                <div className="flex items-center gap-2 mb-2">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                    <path d="M7 11V7a5 5 0 0110 0v4" />
                  </svg>
                  <span className="font-semibold text-green-500">End-to-End Encrypted</span>
                </div>
                <p className="m-0">
                  This QR code securely transfers your encryption key. Your keys never touch our servers - only your devices can decrypt your data.
                </p>
              </div>

              {/* Prevent sleep suggestion */}
              {onPreventSleepModeChange && (
                <div className="mt-3 p-3 bg-blue-500/10 border border-blue-500/20 rounded-lg">
                  <div className="flex items-start gap-2.5">
                    <div className="flex-1">
                      <span className="text-[13px] font-medium text-nim">Prevent sleep while syncing</span>
                      <p className="text-[11px] text-nim-muted mt-1 mb-0">
                        Keeps your computer awake so you can send prompts from your phone. Display can still turn off.
                      </p>
                    </div>
                    <select
                      value={preventSleepMode ?? 'off'}
                      onChange={(e) => onPreventSleepModeChange(e.target.value as 'off' | 'always' | 'pluggedIn')}
                      className="bg-nim-secondary border border-nim rounded px-2 py-1 text-[12px] text-nim cursor-pointer shrink-0 mt-0.5"
                    >
                      <option value="off">Off</option>
                      <option value="always">Always</option>
                      <option value="pluggedIn">When plugged in</option>
                    </select>
                  </div>
                </div>
              )}

              <div className="qr-warning flex items-center gap-2 mt-3 p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg text-xs text-amber-600">
                <svg className="qr-warning-icon shrink-0" width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M8 1a7 7 0 100 14A7 7 0 008 1zM7 5a1 1 0 112 0v3a1 1 0 11-2 0V5zm1 7a1 1 0 100-2 1 1 0 000 2z" />
                </svg>
                <span>Only scan with your own device. This shares your encryption key.</span>
              </div>

              <button
                className="qr-regenerate-button w-full mt-4 px-4 py-2 bg-nim-secondary text-nim-muted border border-nim rounded-md text-sm font-medium cursor-pointer hover:bg-nim-hover"
                onClick={generateQR}
              >
                Regenerate QR Code
              </button>

              {/* Copy pairing data for manual setup (alternative to QR scanning) */}
              {qrPayload && (
                <div className="qr-dev-copy">
                  <button
                    className={`qr-dev-copy-button w-full mt-3 px-4 py-2 border border-nim rounded-md text-[13px] font-medium cursor-pointer flex items-center justify-center gap-1.5 ${
                      copied
                        ? 'bg-green-500 text-white border-green-500'
                        : 'bg-nim-tertiary text-nim-muted hover:bg-nim-hover'
                    }`}
                    onClick={handleCopyPayload}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      {copied ? (
                        <path d="M20 6L9 17l-5-5" />
                      ) : (
                        <>
                          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                          <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                        </>
                      )}
                    </svg>
                    {copied ? 'Copied!' : 'Copy Pairing Data'}
                  </button>
                  <p className="mt-2 text-[11px] text-nim-faint text-center">
                    Can't scan? Paste this into the mobile app's Manual Setup
                  </p>
                </div>
              )}
            </>
          ) : (
            <div className="qr-loading flex flex-col items-center justify-center py-8">
              <div className="qr-spinner w-8 h-8 border-2 border-nim-primary border-t-transparent rounded-full animate-spin mb-3" />
              <p className="text-nim-muted text-sm">Generating QR code...</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
