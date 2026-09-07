export default function Home() {
  return (
    <main style={styles.main}>
      <img src="/Logo.png" alt="Contentstack Logo" style={styles.logo} />
      <h1>Welcome to Contentstack Launch !!!!</h1>
      <p>
        This Next.js site is deployed using the <strong>Contentstack Launch APIs</strong> and
        redeploys via <strong>Bitbucket Pipelines</strong> on every push to the <code>main</code> branch.
      </p>
    </main>
  );
}

const styles = {
  main: {
    minHeight: '100vh',
    padding: '4rem 1rem',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    textAlign: 'center',
    fontFamily: 'Arial, sans-serif',
  },
  logo: {
    width: '200px',
    marginBottom: '2rem',
  },
};
