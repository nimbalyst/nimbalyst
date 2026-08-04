import React from 'react';
export interface InputModalProps {
    isOpen: boolean;
    title: string;
    placeholder: string;
    defaultValue?: string;
    suffix?: string;
    confirmLabel?: string;
    onConfirm: (value: string) => void;
    onCancel: () => void;
}
export declare function InputModal({ isOpen, title, placeholder, defaultValue, suffix, confirmLabel, onConfirm, onCancel, }: InputModalProps): React.JSX.Element | null;
