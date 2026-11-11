import { VISIBILITY_PROFILES, type VisibilityProfile } from "./measurement";
/** Source-format support never qualifies a provider account or grants execution. */
export function observationCapabilities() {
  return VISIBILITY_PROFILES.map((profile) => ({
    profile,
    available: false as const,
    reasons:
      profile === "azure-sol-api"
        ? [
            "Azure account/deployment and executor principal are unqualified.",
            "Token tariff, raw-answer rights and maximum Bing billing exposure are unknown.",
          ]
        : [
            "DataForSEO Standard account/trial access and executor principal are unqualified.",
            `${profile === "consumer-chatgpt" ? "ChatGPT" : "Gemini"} endpoint English/India support, raw-answer rights and account tariff are unknown.`,
          ],
  }));
}
export function observationUnavailable(profile: VisibilityProfile) {
  return observationCapabilities().find((item) => item.profile === profile)!;
}
