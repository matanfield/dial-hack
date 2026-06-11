// Must be the first import of the entrypoint so env vars are loaded before
// any module reads process.env at module scope.
import dotenv from "dotenv";

dotenv.config({ path: [".env.local", ".env"] });
