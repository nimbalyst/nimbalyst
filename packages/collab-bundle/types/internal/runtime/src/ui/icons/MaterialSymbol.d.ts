import React from 'react';
interface MaterialSymbolProps {
    icon: string;
    size?: number;
    fill?: boolean;
    weight?: number;
    grade?: number;
    opticalSize?: number;
    className?: string;
    title?: string;
    style?: React.CSSProperties;
}
export declare function MaterialSymbol({ icon, size, fill, weight, grade, opticalSize, className, title, style: customStyle }: MaterialSymbolProps): React.JSX.Element;
export {};
