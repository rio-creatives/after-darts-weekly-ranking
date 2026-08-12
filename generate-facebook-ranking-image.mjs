import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const TEMPLATE_FILE = "assets/social/facebook-ranking-base-4x5.png";
const OUTPUT_DIR = "generated";

const targetDate = process.env.TARGET_DATE?.trim();

if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate ?? "")) {
  throw new Error("TARGET_DATE must use YYYY-MM-DD format.");
}

const DATA_FILE = path.join(OUTPUT_DIR, `progress-draft-${targetDate}.json`);
const OUTPUT_FILE = path.join(
  OUTPUT_DIR,
  `facebook-ranking-${targetDate}.png`,
);

const rows = [
  { y: 1245, nameFill: "#ffd43b", stroke: "#6f3a00", glow: "#ffb000" },
  { y: 1581, nameFill: "#f3f2ff", stroke: "#31255e", glow: "#a786ff" },
  { y: 1916, nameFill: "#ff8a25", stroke: "#6a2100", glow: "#ff6500" },
];

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function normalizeTop3(value) {
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => ({
      rank: Number(item?.rank),
      player: String(item?.player ?? "").trim(),
      score: Number(item?.score),
    }))
    .filter(
      (item) =>
        Number.isInteger(item.rank) &&
        item.rank >= 1 &&
        item.rank <= 3 &&
        item.player.length > 0 &&
        Number.isFinite(item.score),
    )
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 3);
}

function nameFontSize(name) {
  const length = [...name].length;
  if (length <= 6) return 94;
  if (length <= 9) return 82;
  if (length <= 12) return 72;
  if (length <= 16) return 62;
  return 54;
}

function createOverlay(top3) {
  const content = top3
    .map((item, index) => {
      const style = rows[index];
      const player = escapeXml(item.player);
      const score = escapeXml(Math.round(item.score));
      const fontSize = nameFontSize(item.player);

      return `
        <g filter="url(#glow-${index})">
          <text
            x="990"
            y="${style.y}"
            text-anchor="middle"
            dominant-baseline="middle"
            font-family="DejaVu Sans, Arial, sans-serif"
            font-size="${fontSize}"
            font-weight="900"
            font-style="italic"
            letter-spacing="1"
            fill="${style.nameFill}"
            stroke="${style.stroke}"
            stroke-width="3"
            paint-order="stroke fill"
          >${player}</text>
        </g>
        <text
          x="1510"
          y="${style.y}"
          text-anchor="end"
          dominant-baseline="middle"
          font-family="DejaVu Sans, Arial, sans-serif"
          font-size="72"
          font-weight="900"
          font-style="italic"
          fill="#ffffff"
          stroke="#11121b"
          stroke-width="4"
          paint-order="stroke fill"
        >${score}<tspan font-size="38" dx="10">PTS</tspan></text>`;
    })
    .join("\n");

  const filters = rows
    .map(
      (style, index) => `
        <filter id="glow-${index}" x="-30%" y="-80%" width="160%" height="260%">
          <feGaussianBlur stdDeviation="7" result="blur" />
          <feFlood flood-color="${style.glow}" flood-opacity="0.58" />
          <feComposite in2="blur" operator="in" />
          <feMerge>
            <feMergeNode />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>`,
    )
    .join("\n");

  return Buffer.from(`
    <svg width="2160" height="2700" viewBox="0 0 2160 2700" xmlns="http://www.w3.org/2000/svg">
      <defs>${filters}</defs>
      ${content}
    </svg>
  `);
}

async function main() {
  const payload = JSON.parse(await fs.readFile(DATA_FILE, "utf8"));
  const top3 = normalizeTop3(payload?.facts?.currentTop3);

  if (top3.length !== 3 || top3.some((item, index) => item.rank !== index + 1)) {
    throw new Error(`A complete top 3 was not found in ${DATA_FILE}.`);
  }

  const metadata = await sharp(TEMPLATE_FILE).metadata();
  if (metadata.width !== 2160 || metadata.height !== 2700) {
    throw new Error(
      `Template must be 2160 x 2700 px; received ${metadata.width} x ${metadata.height}.`,
    );
  }

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await sharp(TEMPLATE_FILE)
    .composite([{ input: createOverlay(top3), top: 0, left: 0 }])
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toFile(OUTPUT_FILE);

  console.log(`Saved ${OUTPUT_FILE}`);
  for (const item of top3) {
    console.log(`No.${item.rank}: ${item.player} — ${item.score} PTS`);
  }
}

main().catch((error) => {
  console.error(error.stack ?? error.message ?? error);
  process.exitCode = 1;
});
