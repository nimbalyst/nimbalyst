import React from 'react';
export declare function generateScopeAccentColor(scopeKey: string): string;
export interface ScopeSummaryHeaderProps {
    scopeKey: string;
    scopeName?: React.ReactNode;
    scopePath?: React.ReactNode;
    actions?: React.ReactNode;
    subtitle?: React.ReactNode;
    showAccent?: boolean;
    headerClassName?: string;
    actionsClassName?: string;
}
export declare function ScopeSummaryHeader({ scopeKey, scopeName, scopePath, actions, subtitle, showAccent, headerClassName, actionsClassName, }: ScopeSummaryHeaderProps): React.JSX.Element;
