import sharp from "sharp";
import { mkdirSync, writeFileSync } from "node:fs";
for (const [density, size] of Object.entries({
  mdpi: 48,
  hdpi: 72,
  xhdpi: 96,
  xxhdpi: 144,
  xxxhdpi: 192,
})) {
  const dir = `android/app/src/main/res/mipmap-${density}`;
  mkdirSync(dir, { recursive: true });
  for (const name of [
    "ic_launcher",
    "ic_launcher_round",
    "ic_launcher_foreground",
  ])
    await sharp("public/icon.svg")
      .resize(size)
      .png()
      .toFile(`${dir}/${name}.png`);
}
const icon =
  '<?xml version="1.0" encoding="utf-8"?><adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android"><background android:drawable="@color/ic_launcher_background"/><foreground android:drawable="@drawable/snail_foreground"/></adaptive-icon>';
for (const name of ["ic_launcher", "ic_launcher_round"])
  writeFileSync(`android/app/src/main/res/mipmap-anydpi-v26/${name}.xml`, icon);
writeFileSync(
  "android/app/src/main/res/drawable/snail_foreground.xml",
  '<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="108dp" android:height="108dp" android:viewportWidth="192" android:viewportHeight="192"><path android:fillColor="#285b47" android:pathData="M0,0h192v192h-192z"/><path android:fillColor="@android:color/transparent" android:strokeColor="#fffefa" android:strokeWidth="7" android:strokeLineJoin="round" android:strokeLineCap="round" android:pathData="M55,73h82v58h-82z M55,75l41,31l41,-31 M74,56h44"/></vector>',
);
