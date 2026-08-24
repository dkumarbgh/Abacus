const PDFDocument = require("pdfkit");
const path = require("path");

/**
 * Renders one or more certificates as a single PDF (one certificate per
 * page), streamed directly to `destination`. Used for both single-student
 * generation (a 1-page PDF) and bulk generation (one page per selected
 * student) - same code path either way, which also means printing a bulk
 * batch is just "print this one PDF" rather than juggling a ZIP of files.
 *
 * The background image fills the whole page; each configured field is
 * drawn on top at its stored PERCENTAGE position, converted to real page
 * coordinates from the page's actual size - so the same template renders
 * identically regardless of what resolution the source image was
 * uploaded at.
 *
 * @param {object} opts
 * @param {object} opts.template - a row from certificate_templates
 * @param {Array}  opts.fields - rows from certificate_fields for this template
 * @param {Array<object>} opts.valuesList - one { field_key: displayValue }
 *   object per certificate/page, e.g.
 *   [{ student_name: "Riya Sharma", date: "16 Aug 2026" }, { student_name: "Aditya Kumar", date: "16 Aug 2026" }]
 * @param {import('stream').Writable} opts.destination - where to pipe the PDF (e.g. the HTTP response)
 */
function renderCertificates({ template, fields, valuesList, destination }) {

    // Page size matches the background image's own aspect ratio (most
    // certificates are landscape, but this works for any image shape) -
    // scaled so the longer side is a comfortable print size (~11 inches).
    const MAX_DIMENSION_PT = 11 * 72; // 11 inches in PDF points
    const aspect = template.image_width / template.image_height;
    const pageWidth = aspect >= 1 ? MAX_DIMENSION_PT : MAX_DIMENSION_PT * aspect;
    const pageHeight = aspect >= 1 ? MAX_DIMENSION_PT / aspect : MAX_DIMENSION_PT;

    const doc = new PDFDocument({ size: [pageWidth, pageHeight], margin: 0, autoFirstPage: false });
    doc.pipe(destination);

    const bgAbsolutePath = path.join(__dirname, "..", "public", template.background_path);

    valuesList.forEach(values => {

        doc.addPage({ size: [pageWidth, pageHeight], margin: 0 });

        // Background image, stretched to fill the exact page size.
        doc.image(bgAbsolutePath, 0, 0, { width: pageWidth, height: pageHeight });

        fields.forEach(field => {
            const text = values[field.field_key];
            if (text === undefined || text === null || text === "") return;

            const x = (field.x_pct / 100) * pageWidth;
            const y = (field.y_pct / 100) * pageHeight;

            doc
                .font(field.bold ? "Helvetica-Bold" : "Helvetica")
                .fontSize(field.font_size)
                .fillColor(field.font_color);

            // pdfkit's text() x/y is the box's top-left, not a centered
            // anchor - draw a wide box centered on the stored x so
            // text_align actually centers/right-aligns AROUND the clicked
            // point, not to its right.
            const boxWidth = pageWidth * 0.8;
            doc.text(String(text), x - boxWidth / 2, y, {
                width: boxWidth,
                align: field.text_align || "center"
            });
        });

    });

    doc.end();

}

module.exports = { renderCertificates };
