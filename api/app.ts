import express, { type Express, type Request, type Response } from 'express';

const app: Express = express();
// app.use(cors({}));

app.get('/', (req: Request, res: Response) => {
  res.send('Hello World!');
});

app.use(express.json());

export default app;
