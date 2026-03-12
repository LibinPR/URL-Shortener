import { Router } from 'express';
import { UrlController } from '../controllers/url.controller';

export function createRouter(controller: UrlController): Router {
    const router = Router();

    //thses are under /api/urls
    router.post('/api/urls', controller.shorten);
    router.get('/api/urls/:shortCode/stats', controller.getStats);
    router.delete('/api/urls/:shortCode', controller.deactivate);

    //Redirect route
    //must be defined last bcz its very greedy — it matches any GET /:shortCode
    //order matters in express routing
    router.get('/:shortCode', controller.redirect);

    return router;
}