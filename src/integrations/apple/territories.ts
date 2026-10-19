/**
 * App Store territory ids. App Store Connect identifies territories by ISO 3166-1 alpha-3
 * code; the studio uses alpha-2 storefront codes everywhere else.
 */
const PAIRS =
  "ABW:AW AFG:AF AGO:AO AIA:AI ALB:AL AND:AD ANT:AN ARE:AE ARG:AR ARM:AM ASM:AS ATG:AG AUS:AU AUT:AT AZE:AZ BDI:BI " +
  "BEL:BE BEN:BJ BES:BQ BFA:BF BGD:BD BGR:BG BHR:BH BHS:BS BIH:BA BLR:BY BLZ:BZ BMU:BM BOL:BO BRA:BR BRB:BB BRN:BN " +
  "BTN:BT BWA:BW CAF:CF CAN:CA CHE:CH CHL:CL CHN:CN CIV:CI CMR:CM COD:CD COG:CG COK:CK COL:CO COM:KM CPV:CV CRI:CR " +
  "CUB:CU CUW:CW CXR:CX CYM:KY CYP:CY CZE:CZ DEU:DE DJI:DJ DMA:DM DNK:DK DOM:DO DZA:DZ ECU:EC EGY:EG ERI:ER ESP:ES " +
  "EST:EE ETH:ET FIN:FI FJI:FJ FLK:FK FRA:FR FRO:FO FSM:FM GAB:GA GBR:GB GEO:GE GGY:GG GHA:GH GIB:GI GIN:GN GLP:GP " +
  "GMB:GM GNB:GW GNQ:GQ GRC:GR GRD:GD GRL:GL GTM:GT GUF:GF GUM:GU GUY:GY HKG:HK HND:HN HRV:HR HTI:HT HUN:HU IDN:ID " +
  "IMN:IM IND:IN IRL:IE IRQ:IQ ISL:IS ISR:IL ITA:IT JAM:JM JEY:JE JOR:JO JPN:JP KAZ:KZ KEN:KE KGZ:KG KHM:KH KIR:KI " +
  "KNA:KN KOR:KR KWT:KW LAO:LA LBN:LB LBR:LR LBY:LY LCA:LC LIE:LI LKA:LK LSO:LS LTU:LT LUX:LU LVA:LV MAC:MO MAR:MA " +
  "MCO:MC MDA:MD MDG:MG MDV:MV MEX:MX MHL:MH MKD:MK MLI:ML MLT:MT MMR:MM MNE:ME MNG:MN MNP:MP MOZ:MZ MRT:MR MSR:MS " +
  "MTQ:MQ MUS:MU MWI:MW MYS:MY MYT:YT NAM:NA NCL:NC NER:NE NFK:NF NGA:NG NIC:NI NIU:NU NLD:NL NOR:NO NPL:NP NRU:NR " +
  "NZL:NZ OMN:OM PAK:PK PAN:PA PER:PE PHL:PH PLW:PW PNG:PG POL:PL PRI:PR PRT:PT PRY:PY PSE:PS PYF:PF QAT:QA REU:RE " +
  "ROU:RO RUS:RU RWA:RW SAU:SA SEN:SN SGP:SG SHN:SH SLB:SB SLE:SL SLV:SV SMR:SM SOM:SO SPM:PM SRB:RS SSD:SS STP:ST " +
  "SUR:SR SVK:SK SVN:SI SWE:SE SWZ:SZ SXM:SX SYC:SC TCA:TC TCD:TD TGO:TG THA:TH TJK:TJ TKM:TM TLS:TL TON:TO TTO:TT " +
  "TUN:TN TUR:TR TUV:TV TWN:TW TZA:TZ UGA:UG UKR:UA UMI:UM URY:UY USA:US UZB:UZ VAT:VA VCT:VC VEN:VE VGB:VG VIR:VI " +
  "VNM:VN VUT:VU WLF:WF WSM:WS XKS:XK YEM:YE ZAF:ZA ZMB:ZM ZWE:ZW";

const TO_ALPHA2 = new Map<string, string>();
const TO_ALPHA3 = new Map<string, string>();
for (const pair of PAIRS.split(" ")) {
  const [a3, a2] = pair.split(":") as [string, string];
  TO_ALPHA2.set(a3, a2);
  TO_ALPHA3.set(a2, a3);
}

/** Every territory code App Store Connect accepts (alpha-3). */
export const ASC_TERRITORIES: readonly string[] = [...TO_ALPHA2.keys()];

/** Storefront code (alpha-2, case-insensitive; "UK" means GB) to an App Store Connect territory id. */
export function toAscTerritory(code: string): string {
  const upper = code.toUpperCase();
  const a2 = upper === "UK" ? "GB" : upper;
  const a3 = TO_ALPHA3.get(a2) ?? (TO_ALPHA2.has(upper) ? upper : undefined);
  if (!a3) throw new Error(`Unknown App Store territory: ${code}`);
  return a3;
}

/** App Store Connect territory id to the alpha-2 storefront code (unknown ids pass through). */
export function fromAscTerritory(id: string): string {
  return TO_ALPHA2.get(id.toUpperCase()) ?? id.toUpperCase();
}
