// /admin and everything under it: the feedback dashboard. All logic is in admin/server.js; the two
// pages are bundled into the function as text, so nothing of the dashboard is a public static file.
import app from '../../admin/ui/app.html';
import login from '../../admin/ui/login.html';
import { handleAdmin } from '../../admin/server.js';

export const onRequest = ({ request, env }) => handleAdmin(request, env, { app, login });
