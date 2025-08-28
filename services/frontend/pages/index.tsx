import Head from 'next/head';
import { useRouter } from 'next/router';

import en from '../locales/en/common.json';
import zh from '../locales/zh/common.json';

type LocaleDict = { title: string; heading: string; tagline: string };
const dict: Record<string, LocaleDict> = { en, zh };

export default function Home() {
  const router = useRouter();
  const locale = (router.locale || 'en').split('-')[0];
  const t = dict[locale] || dict.en;

  const switchLocale = async (l: string) => {
    await router.push(router.pathname, router.asPath, { locale: l });
  };

  return (
    <>
      <Head>
        <title>{t.title}</title>
      </Head>
      <main style={{ padding: 24, fontFamily: 'sans-serif' }}>
        <h1>{t.heading}</h1>
        <p>{t.tagline}</p>
        <div style={{ marginTop: 16 }}>
          <button onClick={() => switchLocale('en')} style={{ marginRight: 8 }}>EN</button>
          <button onClick={() => switchLocale('zh')}>中文</button>
        </div>
      </main>
    </>
  );
}
