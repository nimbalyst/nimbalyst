/** Small pieces the type map's inspector panels share. */
import type { ReactNode } from 'react';
import type { RelationshipStatus, TypeMapType } from '../ontologyLabelMap';
export declare function TypeBadge({ type, tone }: {
    type: Pick<TypeMapType, 'name'>;
    tone: number;
}): import("react").JSX.Element;
export declare function StatusTag({ status, long }: {
    status: RelationshipStatus;
    long?: string;
}): import("react").JSX.Element;
export declare function Section({ title, children }: {
    title: string;
    children: ReactNode;
}): import("react").JSX.Element;
export declare function BarRow({ label, value, of, text, onClick }: {
    label: ReactNode;
    value: number;
    of: number;
    text: string;
    onClick?: () => void;
}): import("react").JSX.Element;
export declare function Stat({ value, label }: {
    value: number;
    label: string;
}): import("react").JSX.Element;
export declare function lower(text: string): string;
/** "a market", "an organization". */
export declare function article(text: string): string;
