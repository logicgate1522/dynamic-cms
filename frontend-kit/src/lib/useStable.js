"use client";

import { useRef } from "react";

// Keeps the same object identity while its content is unchanged. useCms()
// needs a stable `defaults`; when they are built from props (one block per
// article / product / ...), wrap them in this.
export function useStable(value) {
    const ref = useRef({ key: null, value });
    const key = JSON.stringify(value);
    if (ref.current.key !== key) ref.current = { key, value };
    return ref.current.value;
}
