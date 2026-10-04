// PDF2-1 — WING (departman) → TASK PROJECT SLUG eşlemesi. TEK GERÇEK KAYNAK.
//
// ÖLÇÜLEN KUSUR (BUG-PDF-V2 · PDF v2 s.9-10, Eren: "DC takım filtresi
// çoklanıyor nedense … yeni sprintleri gitmiş yeni DC takım sekmesi açmış"):
//
//   YAZAN ile OKUYAN farklı slug kullanıyordu.
//     * create_task varsayılanı `DEPARTMENT` env'ini OLDUĞU GİBİ yazıyordu
//       → DC ajanları için `project = "education"` (agents.department).
//     * Board'un DC sekmesi ise `WING_TO_PROJECT.education = 'skool'` ile
//       `skool` süzüyordu → yeni kartlar sekmede GÖRÜNMÜYORDU.
//   Üstüne `teamLabels.PROJECT_SLUG_ALIASES` iki slug'ı da "DC"ye çözdüğü için
//   TAKIM açılır listesinde AYNI ADLA İKİ satır çıkıyordu (`DC 36` / `DC 517`)
//   ve kullanıcı hangisinin hangisi olduğunu ayırt EDEMİYORDU.
//
// Eşlemenin YÖNÜ (neden `education → skool`, tersi değil): ölçüldü, `skool`
// tarafında 517 görev var, `education` tarafında 65. Kanonik slug kalabalık
// olandır; ters yön 517 satırı taşımayı gerektirirdi.
//
// ⚠️ İKİ KOPYA VAR ve bilinçli: renderer kendi kopyasını `TaskBoard.tsx`
// (`WING_TO_PROJECT`) içinde tutar — main süreç dosyaları renderer bundle'ına
// giremez. Kopyaların ayrışması tam da bu kusurun kendisidir, bu yüzden
// `electron/wingProject.test.cjs` içindeki DRIFT KAPISI iki tanımı dosyadan
// okuyup satır satır karşılaştırır: biri değişip diğeri değişmezse KIRMIZI.
'use strict';

/** wing/departman slug → tasks.project slug. Listede olmayan wing KİMLİKTİR. */
const WING_TO_PROJECT = {
  chatflow: 'chatflow',
  education: 'skool',
  crewpane: 'crewpane',
};

/**
 * Bir wing/departman slug'ını board'un okuduğu proje slug'ına çevirir.
 * Bilinmeyen wing için KİMLİK döner (yeni departman = yeni proje) — bu,
 * renderer ikizinin (`wingToProject`) davranışının birebir aynısıdır.
 * @param {string} wing
 * @returns {string}
 */
function wingToProject(wing) {
  const key = typeof wing === 'string' ? wing.trim() : '';
  if (!key) return key;
  return WING_TO_PROJECT[key] ?? key;
}

module.exports = { WING_TO_PROJECT, wingToProject };
