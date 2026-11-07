import express from 'express';
import { errorHandler, notFoundHandler } from '@medicitas/http';
import routes from './modules/routes.ts';

const app = express();

app.use(express.json());

app.use(routes);
app.use(notFoundHandler);
app.use(errorHandler);

export default app;
