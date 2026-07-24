import React from 'react';

export interface RosettaWarningProps {
  isOpen: boolean;
  onClose: () => void;
  onDismiss: () => void;
  onDownload: () => void;
}

const WarningIcon = () => (
  <svg
    className="w-12 h-12 text-white"
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      d="M12 9V13M12 17H12.01M5.07183 19H18.9282C20.4678 19 21.4301 17.3333 20.6603 16L13.7321 4C12.9623 2.66667 11.0378 2.66667 10.268 4L3.33978 16C2.56998 17.3333 3.53223 19 5.07183 19Z"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export const RosettaWarning: React.FC<RosettaWarningProps> = ({
  isOpen,
  onClose,
  onDismiss,
  onDownload,
}) => {
  if (!isOpen) return null;

  const handleDownload = () => {
    onDownload();
    onClose();
  };

  const handleRemindLater = () => {
    onClose();
  };

  const handleDontRemind = () => {
    window.electronAPI.send('dismiss-rosetta-warning');
    onDismiss();
  };

  return (
    <div
      className="nim-overlay bg-black/60"
      onClick={handleRemindLater}
    >
      <div
        className="relative overflow-hidden rounded-2xl p-0 w-[460px] max-w-[90vw] nim-animate-slide-up bg-nim border border-nim shadow-[0_8px_32px_rgba(0,0,0,0.4)]"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          className="absolute top-4 right-4 bg-transparent border-none text-[28px] cursor-pointer p-0 w-8 h-8 flex items-center justify-center leading-none z-[1] rounded-md transition-all duration-200 hover:scale-110 text-nim-muted hover:text-nim hover:bg-nim-hover"
          onClick={handleRemindLater}
          aria-label="Close"
        >
          &times;
        </button>

        <div className="px-8 pt-12 pb-8 text-center">
          <div className="mx-auto mb-6 w-20 h-20 rounded-[20px] flex items-center justify-center bg-gradient-to-br from-amber-500 to-amber-600 shadow-[0_4px_16px_rgba(245,158,11,0.3)]">
            <WarningIcon />
          </div>

          <h2 className="m-0 mb-3 text-2xl font-bold tracking-tight text-nim">
            Running via Rosetta Translation
          </h2>

          <p className="mb-8 text-[15px] leading-relaxed max-w-[380px] mx-auto text-nim-muted">
            You're running the Intel (x64) build on an Apple Silicon Mac.
            Download the native Apple Silicon build for significantly better performance.
          </p>

          <div className="flex justify-center mb-6">
            <button
              className="py-3.5 px-8 rounded-lg border-none text-base font-semibold cursor-pointer whitespace-nowrap flex items-center gap-2.5 text-white transition-all duration-200 hover:-translate-y-0.5 active:translate-y-0 bg-gradient-to-br from-amber-500 to-amber-600 shadow-[0_4px_12px_rgba(245,158,11,0.4)] hover:shadow-[0_6px_16px_rgba(245,158,11,0.5)]"
              onClick={handleDownload}
            >
              Download Apple Silicon Build
            </button>
          </div>

          <div className="pt-4 flex items-center justify-center gap-2 border-t border-nim">
            <button
              className="bg-transparent border-none text-[13px] cursor-pointer py-1 px-2 no-underline transition-colors duration-200 hover:underline text-nim-muted hover:text-nim"
              onClick={handleRemindLater}
            >
              Remind Me Later
            </button>
            <span className="text-[13px] select-none text-nim-faint">
              &bull;
            </span>
            <button
              className="bg-transparent border-none text-[13px] cursor-pointer py-1 px-2 no-underline transition-colors duration-200 hover:underline text-nim-muted hover:text-nim"
              onClick={handleDontRemind}
            >
              Don't Show Again
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
