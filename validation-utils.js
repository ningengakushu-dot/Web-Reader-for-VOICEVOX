// Chrome拡張のコンテキスト境界で共通利用する、副作用のない入力検証。
// OCRのアルゴリズムや閾値には触れず、メッセージの形・数値上限だけを一元化する。
(() => {
    const RECT_MAX_DIMENSION = 100000;
    const RECT_MAX_AREA = 100000000;

    const isFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);
    const isNonNegativeInteger = (value) => Number.isInteger(value) && value >= 0;

    function isRectWithinBounds(rect) {
        if (!rect || !isFiniteNumber(rect.x) || !isFiniteNumber(rect.y)
            || !isFiniteNumber(rect.width) || !isFiniteNumber(rect.height)) {
            return false;
        }
        return rect.x >= 0 && rect.y >= 0
            && rect.width >= 1 && rect.height >= 1
            && rect.width <= RECT_MAX_DIMENSION && rect.height <= RECT_MAX_DIMENSION
            && rect.width * rect.height <= RECT_MAX_AREA;
    }

    function isNumberInRange(value, min, max) {
        return isFiniteNumber(value) && value >= min && value <= max;
    }

    globalThis.VVRadioValidation = Object.freeze({
        RECT_MAX_DIMENSION,
        RECT_MAX_AREA,
        isFiniteNumber,
        isNonNegativeInteger,
        isRectWithinBounds,
        isNumberInRange
    });
})();
