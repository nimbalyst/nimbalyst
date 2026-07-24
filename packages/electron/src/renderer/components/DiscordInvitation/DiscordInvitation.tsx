import React, { useMemo } from 'react';
import { usePostHog } from 'posthog-js/react';

export interface DiscordInvitationProps {
  isOpen: boolean;
  onClose: () => void;
  onDismiss: () => void;
}

const DiscordIcon = ({ className = 'w-5 h-auto' }: { className?: string }) => (
  <svg className={className} viewBox="0 0 71 55" fill="none" xmlns="http://www.w3.org/2000/svg">
    <g clipPath="url(#clip0)">
      <path d="M60.1045 4.8978C55.5792 2.8214 50.7265 1.2916 45.6527 0.41542C45.5603 0.39851 45.468 0.440769 45.4204 0.525289C44.7963 1.6353 44.105 3.0834 43.6209 4.2216C38.1637 3.4046 32.7345 3.4046 27.3892 4.2216C26.905 3.0581 26.1886 1.6353 25.5617 0.525289C25.5141 0.443589 25.4218 0.40133 25.3294 0.41542C20.2584 1.2888 15.4057 2.8186 10.8776 4.8978C10.8384 4.9147 10.8048 4.9429 10.7825 4.9795C1.57795 18.7309 -0.943561 32.1443 0.293408 45.3914C0.299005 45.4562 0.335386 45.5182 0.385761 45.5576C6.45866 50.0174 12.3413 52.7249 18.1147 54.5195C18.2071 54.5477 18.305 54.5139 18.3638 54.4378C19.7295 52.5728 20.9469 50.6063 21.9907 48.5383C22.0523 48.4172 21.9935 48.2735 21.8676 48.2256C19.9366 47.4931 18.0979 46.6 16.3292 45.5858C16.1893 45.5041 16.1781 45.304 16.3068 45.2082C16.679 44.9293 17.0513 44.6391 17.4067 44.3461C17.471 44.2926 17.5606 44.2813 17.6362 44.3151C29.2558 49.6202 41.8354 49.6202 53.3179 44.3151C53.3935 44.2785 53.4831 44.2898 53.5502 44.3433C53.9057 44.6363 54.2779 44.9293 54.6529 45.2082C54.7816 45.304 54.7732 45.5041 54.6333 45.5858C52.8646 46.6197 51.0259 47.4931 49.0921 48.2228C48.9662 48.2707 48.9102 48.4172 48.9718 48.5383C50.038 50.6034 51.2554 52.5699 52.5959 54.435C52.6519 54.5139 52.7526 54.5477 52.845 54.5195C58.6464 52.7249 64.529 50.0174 70.6019 45.5576C70.6551 45.5182 70.6887 45.459 70.6943 45.3942C72.1747 30.0791 68.2147 16.7757 60.1968 4.9823C60.1772 4.9429 60.1437 4.9147 60.1045 4.8978ZM23.7259 37.3253C20.2276 37.3253 17.3451 34.1136 17.3451 30.1693C17.3451 26.225 20.1717 23.0133 23.7259 23.0133C27.308 23.0133 30.1626 26.2532 30.1066 30.1693C30.1066 34.1136 27.28 37.3253 23.7259 37.3253ZM47.3178 37.3253C43.8196 37.3253 40.9371 34.1136 40.9371 30.1693C40.9371 26.225 43.7636 23.0133 47.3178 23.0133C50.9 23.0133 53.7545 26.2532 53.6986 30.1693C53.6986 34.1136 50.9 37.3253 47.3178 37.3253Z" fill="white"/>
    </g>
    <defs>
      <clipPath id="clip0">
        <rect width="71" height="55" fill="white"/>
      </clipPath>
    </defs>
  </svg>
);

const socialLinks = [
  {
    name: 'LinkedIn',
    url: 'https://linkedin.com/company/nimbalyst',
    color: '#0A66C2',
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" className="w-8 h-8">
        <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/>
      </svg>
    ),
  },
  {
    name: 'YouTube',
    url: 'https://youtube.com/@nimbalyst',
    color: '#FF0000',
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" className="w-8 h-8">
        <path d="M23.498 6.186a3.016 3.016 0 00-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 00.502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 002.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 002.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
      </svg>
    ),
  },
  {
    name: 'X',
    url: 'https://x.com/nimbalyst',
    color: '#000000',
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" className="w-7 h-7">
        <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
      </svg>
    ),
  },
  {
    name: 'TikTok',
    url: 'https://www.tiktok.com/@nimbalyst',
    color: '#fe2c55',
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" className="w-7 h-7">
        <path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z"/>
      </svg>
    ),
  },
  {
    name: 'Instagram',
    url: 'https://www.instagram.com/nimbalyst',
    color: '#E4405F',
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" className="w-8 h-8">
        <path d="M12 0C8.74 0 8.333.015 7.053.072 5.775.132 4.905.333 4.14.63c-.789.306-1.459.717-2.126 1.384S.935 3.35.63 4.14C.333 4.905.131 5.775.072 7.053.012 8.333 0 8.74 0 12s.015 3.667.072 4.947c.06 1.277.261 2.148.558 2.913.306.788.717 1.459 1.384 2.126.667.666 1.336 1.079 2.126 1.384.766.296 1.636.499 2.913.558C8.333 23.988 8.74 24 12 24s3.667-.015 4.947-.072c1.277-.06 2.148-.262 2.913-.558.788-.306 1.459-.718 2.126-1.384.666-.667 1.079-1.335 1.384-2.126.296-.765.499-1.636.558-2.913.06-1.28.072-1.687.072-4.947s-.015-3.667-.072-4.947c-.06-1.277-.262-2.149-.558-2.913-.306-.789-.718-1.459-1.384-2.126C21.319 1.347 20.651.935 19.86.63c-.765-.297-1.636-.499-2.913-.558C15.667.012 15.26 0 12 0zm0 2.16c3.203 0 3.585.016 4.85.071 1.17.055 1.805.249 2.227.415.562.217.96.477 1.382.896.419.42.679.819.896 1.381.164.422.36 1.057.413 2.227.057 1.266.07 1.646.07 4.85s-.015 3.585-.074 4.85c-.061 1.17-.256 1.805-.421 2.227-.224.562-.479.96-.899 1.382-.419.419-.824.679-1.38.896-.42.164-1.065.36-2.235.413-1.274.057-1.649.07-4.859.07-3.211 0-3.586-.015-4.859-.074-1.171-.061-1.816-.256-2.236-.421-.569-.224-.96-.479-1.379-.899-.421-.419-.69-.824-.9-1.38-.165-.42-.359-1.065-.42-2.235-.045-1.26-.061-1.649-.061-4.844 0-3.196.016-3.586.061-4.861.061-1.17.255-1.814.42-2.234.21-.57.479-.96.9-1.381.419-.419.81-.689 1.379-.898.42-.166 1.051-.361 2.221-.421 1.275-.045 1.65-.06 4.859-.06l.045.03zm0 3.678a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16c-2.21 0-4-1.79-4-4s1.79-4 4-4 4 1.79 4 4-1.79 4-4 4zm7.846-10.405a1.441 1.441 0 11-2.882 0 1.441 1.441 0 012.882 0z"/>
      </svg>
    ),
  },
] as const;

export const DiscordInvitation: React.FC<DiscordInvitationProps> = ({
  isOpen,
  onClose,
  onDismiss
}) => {
  const posthog = usePostHog();
  const logoSrc = new URL('/nimbalyst-logo.png', import.meta.url).href;

  // Map social link names to their channel identifiers
  const channelMap = useMemo(() => ({
    'Discord': 'discord',
    'LinkedIn': 'linkedin',
    'YouTube': 'youtube',
    'X': 'x',
    'TikTok': 'tiktok',
    'Instagram': 'instagram',
  }), []);

  if (!isOpen) return null;

  const handleOpenLink = (url: string, linkName?: string) => {
    // Track social link click
    if (linkName && posthog) {
      const channel = channelMap[linkName as keyof typeof channelMap] || linkName.toLowerCase();
      posthog.capture('social_link_clicked', {
        channel,
      });
    }
    window.electronAPI.invoke('open-external', url);
  };

  const handleRemindLater = () => {
    onClose();
  };

  const handleDontRemind = () => {
    window.electronAPI.send('dismiss-discord-invitation');
    onDismiss();
  };

  return (
    <div
      className="discord-invitation-overlay fixed inset-0 flex items-center justify-center z-[10000] bg-black/60 animate-[nim-fade-in_0.2s_ease-out]"
      onClick={handleRemindLater}
    >
      <div
        className="discord-invitation relative p-0 w-[420px] max-w-[90vw] rounded-2xl overflow-hidden border border-[var(--nim-border)] bg-[var(--nim-bg)] shadow-[0_8px_32px_rgba(0,0,0,0.4)] animate-[nim-slide-up_0.3s_ease-out]"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="discord-invitation-title"
        aria-describedby="discord-invitation-description"
      >
        <button
          className="absolute top-4 right-4 w-8 h-8 p-0 flex items-center justify-center bg-transparent border-none text-[24px] leading-none cursor-pointer rounded-md z-[1] text-[var(--nim-text-muted)] transition-[color,transform] duration-200 hover:text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)] hover:scale-110"
          onClick={handleRemindLater}
          aria-label="Close"
        >
          ×
        </button>

        <div className="px-8 pt-10 pb-8 text-center">
          <img src={logoSrc} alt="Nimbalyst" className="mx-auto mb-5 h-12 w-auto object-contain" />

          <h2 id="discord-invitation-title" className="discord-invitation-title m-0 mb-3 text-2xl font-bold tracking-[-0.5px] text-[var(--nim-text)]">
            Join the Community
          </h2>

          <p id="discord-invitation-description" className="discord-invitation-message mb-6 text-[15px] leading-[1.6] max-w-[340px] mx-auto text-[var(--nim-text-muted)]">
            Get faster help, share feedback with the team, and stay up to date on new releases.
          </p>

          <div className="discord-invitation-buttons flex justify-center mb-6">
            <button
              className="discord-invitation-button discord-invitation-button-primary w-full max-w-[320px] px-8 py-3.5 rounded-lg border-none text-base font-semibold cursor-pointer whitespace-nowrap flex items-center justify-center gap-2.5 text-white bg-[var(--nim-primary)] shadow-[0_4px_12px_rgba(0,0,0,0.24)] transition-all duration-200 hover:-translate-y-0.5 hover:bg-[var(--nim-primary-hover)] hover:shadow-[0_6px_16px_rgba(0,0,0,0.3)] active:translate-y-0"
              onClick={() => handleOpenLink('https://discord.gg/ubZDt4esEn', 'Discord')}
            >
              <DiscordIcon className="w-5 h-auto text-white" />
              Join Discord
            </button>
          </div>

          <div className="mb-6 px-4">
            <p className="m-0 mb-4 text-sm font-semibold uppercase tracking-[0.08em] text-[var(--nim-text-muted)]">
              Follow Nimbalyst
            </p>
            <div className="flex items-center justify-center gap-3">
              {socialLinks.map((link) => (
                <button
                  key={link.name}
                  className="w-11 h-11 flex items-center justify-center border-none bg-transparent text-[var(--nim-primary)] cursor-pointer transition-all duration-200 hover:-translate-y-0.5 hover:opacity-70 p-0"
                  onClick={() => handleOpenLink(link.url, link.name)}
                  aria-label={link.name}
                  title={link.name}
                >
                  {link.icon}
                </button>
              ))}
            </div>
          </div>

          <div className="discord-invitation-footer pt-4 flex items-center justify-center gap-2 border-t border-[var(--nim-border)]">
            <button
              className="bg-transparent border-none text-[13px] cursor-pointer px-2 py-1 no-underline text-[var(--nim-text-muted)] transition-colors duration-200 hover:text-[var(--nim-text)] hover:underline"
              onClick={handleRemindLater}
            >
              Remind Me Later
            </button>
            <span className="text-[13px] select-none text-[var(--nim-text-faint)]">•</span>
            <button
              className="bg-transparent border-none text-[13px] cursor-pointer px-2 py-1 no-underline text-[var(--nim-text-muted)] transition-colors duration-200 hover:text-[var(--nim-text)] hover:underline"
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
