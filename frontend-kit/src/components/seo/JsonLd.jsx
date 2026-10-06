// Renders a JSON-LD graph. The backend already escapes "<" in string
// values; the replace below is a second guard for any other source.
export default function JsonLd({ data }) {
    if (!data) return null;

    return (
        <script
            type="application/ld+json"
            dangerouslySetInnerHTML={{
                __html: JSON.stringify(data).replace(/</g, "\\u003c"),
            }}
        />
    );
}
