import app from './app.ts';

app.listen(process.env.API_INTERNAL_PORT, () => {
  console.log(`Server running at ${process.env.BACKEND_INTERNAL_PORT}`);
});
