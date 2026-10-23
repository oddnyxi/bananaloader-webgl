// Parcel's "bundle-text:" scheme inlines the compiled CSS as a string,
// which is what we inject into the shadow root.
import * as style from 'bundle-text:./index.css';

// bundle-text yields the compiled CSS string (namespace import avoids Parcel's tree-shaking warning)
const css = style.default ?? style;

export default css;
