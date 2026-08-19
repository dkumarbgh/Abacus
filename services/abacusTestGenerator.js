const PDFDocument = require("pdfkit");

/**
 * Generates one randomized abacus arithmetic problem: a column of numbers
 * to add (and optionally subtract) mentally/on the abacus, ending in a
 * blank box for the answer.
 *
 * Numbers are kept non-negative at every step when subtraction is
 * involved (you can't have a negative bead count on an abacus) - if a
 * subtraction would take the running total below zero, that step falls
 * back to addition instead, rather than producing an invalid problem.
 *
 * @param {number} digitCount - digits per number, e.g. 2 -> 10-99
 * @param {number} operandCount - how many numbers in the column, e.g. 5
 * @param {boolean} includeSubtraction - mix in some subtraction steps
 * @returns {{ operands: Array<{value:number, op:'+'|'-'}>, answer: number }}
 */
function generateProblem(digitCount, operandCount, includeSubtraction) {

    const min = Math.pow(10, digitCount - 1);
    const max = Math.pow(10, digitCount) - 1;
    const randomNumber = () => Math.floor(Math.random() * (max - min + 1)) + min;

    const operands = [];
    let running = 0;

    for (let i = 0; i < operandCount; i++) {
        const value = randomNumber();
        // First number is always a plain addition (there's nothing to
        // subtract FROM yet). After that, roughly half are subtraction
        // when enabled, but only if it wouldn't take the total negative.
        const wantsSubtraction = includeSubtraction && i > 0 && Math.random() < 0.5;
        const canSubtract = wantsSubtraction && running - value >= 0;
        const op = canSubtract ? "-" : "+";

        operands.push({ value, op });
        running = op === "+" ? running + value : running - value;
    }

    return { operands, answer: running };
}

/**
 * Renders a full test paper: a title/header, `problemCount` problems laid
 * out in a 2-column grid, followed by a separate Answer Key page for the
 * teacher. Returns the generated problems too, in case the caller wants
 * to log/reuse them (e.g. re-rendering the same paper for a WhatsApp
 * caption preview) - though by default every call generates a FRESH
 * random set, which is the point for repeat practice.
 *
 * @param {object} opts
 * @param {string} opts.levelName
 * @param {number} opts.digitCount
 * @param {number} opts.operandCount
 * @param {number} opts.problemCount
 * @param {boolean} opts.includeSubtraction
 * @param {string} [opts.schoolName]
 * @param {string} [opts.paperDate] - "YYYY-MM-DD" shown on the paper header; defaults to today if omitted
 * @param {import('stream').Writable} opts.destination
 * @returns {Array} the generated problems, in the same order as printed
 */
function renderTestPaper({ levelName, digitCount, operandCount, problemCount, includeSubtraction, schoolName, paperDate, destination }) {

    const problems = [];
    for (let i = 0; i < problemCount; i++) {
        problems.push(generateProblem(digitCount, operandCount, includeSubtraction));
    }

    const doc = new PDFDocument({ size: "A4", margin: 40 });
    doc.pipe(destination);

    // ---- Question paper ----
    doc.fontSize(18).font("Helvetica-Bold").text(schoolName || "Abacus Test Paper", { align: "center" });
    doc.fontSize(13).font("Helvetica").text(`Level: ${levelName}`, { align: "center" });
    doc.fontSize(10).fillColor("#555").text(`Date: ${paperDate || new Date().toISOString().slice(0, 10)}    Name: _______________________`, { align: "center" });
    doc.moveDown(1);
    doc.fillColor("#000");

    const colWidth = (doc.page.width - doc.page.margins.left - doc.page.margins.right) / 2 - 15;
    const startX = doc.page.margins.left;
    const startY = doc.y;
    let col = 0;
    let rowY = startY;
    let maxRowHeightThisRow = 0;

    problems.forEach((problem, i) => {

        const x = startX + col * (colWidth + 30);
        const lineHeight = 16;
        const boxHeight = (problem.operands.length + 2) * lineHeight + 10;

        // New page if this problem wouldn't fit.
        if (rowY + boxHeight > doc.page.height - doc.page.margins.bottom) {
            doc.addPage();
            rowY = doc.page.margins.top;
            col = 0;
        }

        let y = rowY;
        doc.fontSize(10).font("Helvetica-Bold").text(`${i + 1}.`, x, y);
        y += lineHeight;

        doc.font("Helvetica").fontSize(12);
        problem.operands.forEach((op, idx) => {
            const sign = idx === 0 ? " " : op.op;
            doc.text(`${sign}  ${op.value}`, x + 15, y, { width: colWidth - 15, align: "right" });
            y += lineHeight;
        });

        // Answer line + blank box.
        doc.moveTo(x + 15, y).lineTo(x + colWidth, y).strokeColor("#999").stroke();
        y += 4;
        doc.rect(x + 15, y, colWidth - 15, lineHeight + 4).strokeColor("#333").stroke();

        maxRowHeightThisRow = Math.max(maxRowHeightThisRow, boxHeight);

        col++;
        if (col >= 2) {
            col = 0;
            rowY += maxRowHeightThisRow + 15;
            maxRowHeightThisRow = 0;
        }

    });

    // ---- Answer key (separate page, for the teacher) ----
    doc.addPage();
    doc.fontSize(16).font("Helvetica-Bold").text("Answer Key", { align: "center" });
    doc.fontSize(11).font("Helvetica").fillColor("#555").text(`Level: ${levelName}`, { align: "center" });
    doc.moveDown(1);
    doc.fillColor("#000").fontSize(11);

    const keyColWidth = (doc.page.width - doc.page.margins.left - doc.page.margins.right) / 4;
    let keyCol = 0;
    let keyX = doc.page.margins.left;
    let keyY = doc.y;

    problems.forEach((problem, i) => {
        if (keyY > doc.page.height - doc.page.margins.bottom - 20) {
            doc.addPage();
            keyY = doc.page.margins.top;
        }
        doc.text(`${i + 1}. ${problem.answer}`, keyX + keyCol * keyColWidth, keyY, { width: keyColWidth });
        keyCol++;
        if (keyCol >= 4) {
            keyCol = 0;
            keyY += 20;
        }
    });

    doc.end();

    return problems;

}

module.exports = { generateProblem, renderTestPaper };
