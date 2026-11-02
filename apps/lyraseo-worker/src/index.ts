// Queue and Browser Run bindings will be enabled only after their security and
// runtime contracts pass controlled tests. No live site work runs in this build.
export default {
  fetch(): Response {
    return new Response("Provider work is unavailable until configured.", { status: 503 });
  },
};
