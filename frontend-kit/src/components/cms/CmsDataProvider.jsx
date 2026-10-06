"use client";

import { createContext, useContext } from "react";

const CmsDataContext = createContext({});

// Hands server-fetched `home/<name>/` payloads to client sections so the
// first render (and the HTML crawlers see) already contains CMS content.
// Nested providers merge with their parent.
export function CmsDataProvider({ data, children }) {
    const parent = useContext(CmsDataContext);
    return (
        <CmsDataContext.Provider value={{ ...parent, ...data }}>
            {children}
        </CmsDataContext.Provider>
    );
}

export function useCmsInitial(name) {
    return useContext(CmsDataContext)[name];
}
