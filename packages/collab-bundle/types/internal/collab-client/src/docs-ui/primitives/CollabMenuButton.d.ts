/** One row of a shared-docs context menu: icon, label, an optional faint trailing note. */
import React from 'react';
export declare const CollabMenuButton: React.FC<{
    icon: string;
    label: string;
    trailing?: string;
    disabled?: boolean;
    danger?: boolean;
    /** Draws the icon filled (a set favorite star). */
    fill?: boolean;
    className?: string;
    title?: string;
    onClick: () => void;
}>;
