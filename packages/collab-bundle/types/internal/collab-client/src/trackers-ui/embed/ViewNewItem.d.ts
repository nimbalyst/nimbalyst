/** A refused create keeps its title in place for correction or retry. */
export declare function ViewNewItem({ onCreate }: {
    onCreate(title: string, requestId: string): Promise<void>;
}): import("react").JSX.Element;
