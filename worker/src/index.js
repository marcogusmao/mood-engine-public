// Public addon and private intake have separate routing and authorization.
import { createHandler } from './handler.js';
import { createUploadApi, createActivePublication } from './upload/api.js';
export { WillState } from './upload/state.js';
const publication = createActivePublication(); // one 60 s copy of the active publication for the addon and for GET /publication, dropped when an acknowledgement is accepted (S1, S1b)
const handle = createHandler({ publicationCache: publication }), api = createUploadApi({ publicationCache: publication });
export default { async fetch(request, env, ctx) { return (await api(request, env, ctx)) || handle(request, env, ctx); } };
